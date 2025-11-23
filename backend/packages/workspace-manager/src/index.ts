import Docker from 'dockerode';
import tar from 'tar-stream';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class WorkspaceManager {
  private docker: Docker;

  constructor() {
    this.docker = new Docker();
  }

  async createWarmWorkspace(projectId: string, repoUrl: string, apiKey: string, envVars: Record<string, string> = {}): Promise<{ containerId: string; volumeName: string; imageName: string; imageDigest: string }> {
    const volumeName = `ws-${projectId}`;
    const imageName = process.env.WORKSPACE_IMAGE || 'codexrt-workspace:v0.1';

    console.log(`Creating volume: ${volumeName}`);
    await this.ensureVolume(volumeName);

    console.log(`Starting container for project ${projectId} with image ${imageName}`);
    
    const env = [`OPENAI_API_KEY=${apiKey}`];
    for (const [key, value] of Object.entries(envVars)) {
      env.push(`${key}=${value}`);
    }

    // Create container
    const container = await this.docker.createContainer({
      Image: imageName,
      Env: env,
      HostConfig: {
        Binds: [`${volumeName}:/workspace/repo`],
        PortBindings: {
          // If we were exposing to host, but orchestrator can access via container IP or same net
          // For v0.1 let's just expose it to be safe or strictly rely on internal networking if in compose
          // But the guide says "expose port 7000 (Map to a random host port or keep internal if on same network)"
          // and "in local docker: use container IP from dockerode inspect."
          // So we will expose it but not necessarily bind it to a specific host port unless debugging.
          // Actually, letting Docker assign a random port is good for local dev if we need to hit it from outside.
          '7000/tcp': [{ HostPort: '0' }] // Random host port
        },
        NetworkMode: 'codex-net',
        Memory: 536870912, // 512MB
        NanoCpus: 500000000 // 0.5 CPU
      },
      ExposedPorts: {
        '7000/tcp': {}
      },
      Tty: true, // Keep it running with the tail -f command in Dockerfile
    });

    try {
      await container.start();
      const containerId = container.id;
      console.log(`Container started: ${containerId}`);

      // Inspect to get image digest
      const inspectData = await container.inspect();
      const realImageName = inspectData.Config.Image;
      const imageDigest = inspectData.Image; // This is the ID/Digest of the image instance

      // Clone Repo
      console.log(`Cloning repo from ${repoUrl} into /workspace/repo...`);
      await this.cloneRepo(container, repoUrl);

      return {
        containerId,
        volumeName,
        imageName: realImageName,
        imageDigest
      };
    } catch (error) {
      console.error(`Failed to start workspace or clone repo. Cleaning up container ${container.id}...`, error);
      try {
        await container.stop();
      } catch (e) { /* ignore */ }
      try {
        await container.remove();
      } catch (e) { /* ignore */ }
      throw error;
    }
  }

  private async cloneRepo(container: Docker.Container, repoUrl: string) {
    const exec = await container.exec({
      Cmd: ['bash', '-c', `if [ ! -d .git ]; then git clone ${repoUrl} .; fi`],
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: '/workspace/repo'
    });

    const stream = await exec.start({}); // start execution

    // Simple wait for stream to end
    // Note: In some environments, stream 'end' event might be delayed or not fire if TTY interactions are complex.
    // We'll consume the stream but also poll for completion as a fallback.
    container.modem.demuxStream(stream, process.stdout, process.stderr);

    await new Promise<void>((resolve, reject) => {
        const checkInterval = setInterval(async () => {
            try {
                const inspect = await exec.inspect();
                if (!inspect.Running) {
                    clearInterval(checkInterval);
                    resolve();
                }
            } catch (e) {
                clearInterval(checkInterval);
                reject(e);
            }
        }, 500);

        // Timeout after 30 seconds
        const timeout = setTimeout(() => {
             clearInterval(checkInterval);
             console.warn("Clone operation timed out, proceeding anyway (assuming success or partial)...");
             resolve();
        }, 30000);

        stream.on('end', () => {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            resolve();
        });
        stream.on('error', (err) => {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            reject(err);
        });
    });

    // Check exit code
    const inspect = await exec.inspect();
    if (inspect.ExitCode !== 0) {
      throw new Error(`Git clone failed with exit code ${inspect.ExitCode}`);
    }
    console.log('Repo cloned (or already existed).');
  }

  async stopWorkspace(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop();
      await container.remove();
      console.log(`Container ${containerId} stopped and removed.`);
    } catch (err) {
        console.error(`Error stopping container ${containerId}:`, err);
        // Ignore if already stopped/removed or not found to be idempotent-ish
    }
  }

  private async ensureVolume(volumeName: string) {
    try {
      await this.docker.createVolume({ Name: volumeName });
    } catch (err) {
      // If volume exists, that's fine.
      // Dockerode might throw if it exists, or might just return it.
      // Usually it's fine, but let's catch just in case.
    }
  }

  async deleteVolume(volumeName: string): Promise<void> {
    try {
      const volume = this.docker.getVolume(volumeName);
      await volume.remove();
      console.log(`Volume ${volumeName} removed.`);
    } catch (err) {
      console.error(`Error removing volume ${volumeName}:`, err);
      // We don't rethrow because if it's already gone, that's fine for GC purposes.
    }
  }
  
  // Helper to get container IP if needed later
  async getContainerIp(containerId: string): Promise<string> {
      const container = this.docker.getContainer(containerId);
      const data = await container.inspect();
      if (data.NetworkSettings.IPAddress) {
          return data.NetworkSettings.IPAddress;
      }
      // Fallback for custom networks
      const networks = data.NetworkSettings.Networks;
      if (networks) {
          const netName = Object.keys(networks)[0];
          if (netName && networks[netName]) {
              return networks[netName].IPAddress;
          }
      }
      throw new Error(`Could not find IP address for container ${containerId}`);
  }

  async getContainerHostPort(containerId: string, internalPort: number): Promise<string> {
      const container = this.docker.getContainer(containerId);
      const data = await container.inspect();
      const bindings = data.NetworkSettings.Ports[`${internalPort}/tcp`];
      if (bindings && bindings.length > 0) {
          return bindings[0].HostPort;
      }
      throw new Error(`Port ${internalPort} not exposed/mapped`);
  }

  async getContainerArchive(containerId: string, path: string): Promise<NodeJS.ReadableStream> {
    const container = this.docker.getContainer(containerId);
    return container.getArchive({ path });
  }

  async putFile(containerId: string, filePath: string, content: string): Promise<void> {
    console.log(`[putFile] Start: ${containerId} -> ${filePath}`);
    const container = this.docker.getContainer(containerId);
    const dir = filePath.split('/').slice(0, -1).join('/');
    const fileName = filePath.split('/').pop() || 'file';
    
    if (dir) {
        try {
             const exec = await container.exec({
                Cmd: ['mkdir', '-p', dir],
                AttachStdout: true,
                AttachStderr: true
            });
            const stream = await exec.start({});
            await new Promise((resolve, reject) => {
                stream.on('end', resolve);
                stream.on('error', reject);
                stream.resume();
            });
            console.log(`[putFile] Created dir: ${dir}`);
        } catch (e) {
            console.error(`[putFile] Failed to mkdir:`, e);
            throw e;
        }
    }

    try {
        const pack = tar.pack();
        pack.entry({ name: fileName }, content);
        pack.finalize();

        await container.putArchive(pack, { path: dir });
        console.log(`[putFile] Wrote file: ${filePath}`);
    } catch (e) {
        console.error(`[putFile] Failed to write file:`, e);
        throw e;
    }
  }
}