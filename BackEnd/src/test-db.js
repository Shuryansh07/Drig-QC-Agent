import "dotenv/config";
import { prisma } from "./config/prisma.js";

try {
  await prisma.$queryRaw`SELECT 1`;

  console.log("Database connection successful");
} catch (error) {
  console.error("Database connection failed:");
  console.error(error);
} finally {
  await prisma.$disconnect();
}