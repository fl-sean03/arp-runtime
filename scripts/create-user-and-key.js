const { Client } = require('pg');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Parse args
const args = process.argv.slice(2);
const emailArg = args.find(a => a.startsWith('--email='));
const nameArg = args.find(a => a.startsWith('--name='));

if (!emailArg) {
    console.error('Usage: node scripts/create-user-and-key.js --email=test@example.com [--name="Test User"]');
    process.exit(1);
}

const email = emailArg.split('=')[1];
const name = nameArg ? nameArg.split('=')[1] : null;

const client = new Client({
    connectionString: process.env.POSTGRES_URL || 'postgres://postgres:postgrespassword@localhost:5432/codexrt'
});

async function main() {
    try {
        await client.connect();

        // 1. Insert User
        const userRes = await client.query(
            `INSERT INTO users (email, name, is_admin) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name 
             RETURNING id, email`,
            [email, name, false]
        );
        const user = userRes.rows[0];
        console.log(`User created/updated: ${user.id} (${user.email})`);

        // 2. Generate Token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hash = crypto.createHash('sha256').update(rawToken).digest('hex');

        // 3. Insert Key
        await client.query(
            `INSERT INTO api_keys (user_id, token_hash, label) 
             VALUES ($1, $2, $3)`,
            [user.id, hash, 'Generated via script']
        );

        console.log('\nAPI Key generated successfully!');
        console.log('---------------------------------------------------');
        console.log(`User ID:   ${user.id}`);
        console.log(`API Key:   ${rawToken}`);
        console.log('---------------------------------------------------');
        console.log('Make sure to copy this key now. You will not be able to see it again.');

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

main();