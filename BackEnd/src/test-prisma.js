import "dotenv/config";
import { prisma } from "./config/prisma.js";

try {
  const testRow = await prisma.testTable.create({
    data: {
      message: "Database connection test",
    },
  });

  console.log("Row created successfully:");
  console.log(testRow);
} catch (error) {
  console.error("Failed to create row:");
  console.error(error);
} finally {
  await prisma.$disconnect();
}