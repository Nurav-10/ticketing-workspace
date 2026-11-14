import { verifyDevelopmentBaseline } from './baseline-guard.js';

try {
  await verifyDevelopmentBaseline();
  console.info('Development schema matches the Prisma baseline, including reviewed SQL-only constraints.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
