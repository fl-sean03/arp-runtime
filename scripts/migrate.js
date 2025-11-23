const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const schemaPath = path.join(__dirname, '../backend/infra/schema.sql');

async function migrate() {
  console.log('Starting migration...');
  
  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL environment variable is not set.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log('Connected to database.');

    const sql = fs.readFileSync(schemaPath, 'utf8');
    console.log(`Reading schema from ${schemaPath}`);

    await client.query(sql);
    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();