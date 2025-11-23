type MetricLabels = Record<string, string | number | boolean>;

class Metrics {
  private counters: Map<string, number> = new Map();

  private getMetricKey(name: string, labels: MetricLabels = {}): string {
    const sortedKeys = Object.keys(labels).sort();
    if (sortedKeys.length === 0) {
      return name;
    }
    const labelString = sortedKeys.map(k => `${k}="${labels[k]}"`).join(',');
    return `${name}{${labelString}}`;
  }

  increment(name: string, labels: MetricLabels = {}) {
    const key = this.getMetricKey(name, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + 1);
  }

  getMetrics() {
    // Format for Prometheus text exposition format
    // Although the original code returned a simple object, the requirements
    // imply we might want proper prometheus formatting or at least structured return.
    // However, the original code returned { ...this.counts } which was Record<string, number>.
    // To maintain backward compatibility with any simple JSON viewers while enabling Prometheus-style structure:
    
    const result: Record<string, number> = {};
    for (const [key, value] of this.counters.entries()) {
        result[key] = value;
    }
    return result;
  }
}

export const metrics = new Metrics();