import { markDevelopmentBaseline, verifyDevelopmentBaseline } from './baseline-guard.js';

try {
  const target = await verifyDevelopmentBaseline();
  markDevelopmentBaseline(target);
  console.info('Prisma marked the verified development baseline as already applied.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
