import "dotenv/config";
import { pool } from "./db/pool.js";

try {
  const { rows } = await pool.query("select 1 as ok");
  console.log("Database connection successful:", rows[0]);
} catch (error) {
  console.error("Database connection failed:");
  console.error(error);
} finally {
  await pool.end();
}
