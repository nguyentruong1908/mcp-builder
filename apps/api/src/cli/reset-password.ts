// Recovery: node dist/cli/reset-password.js <username>
import '../env.js';
import { generatePassword, hashPassword } from '../auth/password.js';
import { PrismaService } from '../core/prisma.service.js';

const username = process.argv[2]?.trim().toLowerCase();
if (!username) {
  console.error('Usage: node dist/cli/reset-password.js <username>');
  process.exit(1);
}

const prisma = new PrismaService();
try {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    console.error(`No user named "${username}".`);
    process.exitCode = 1;
  } else {
    const password = generatePassword();
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password), mustChangePassword: true, disabled: false } }),
      prisma.session.deleteMany({ where: { userId: user.id } }),
      prisma.auditLog.create({ data: { actor: 'system', action: 'user.reset_password', target: username, meta: { via: 'cli' } } }),
    ]);
    console.log(`Temporary password for ${username} (must be changed at next sign-in): ${password}`);
  }
} finally {
  await prisma.$disconnect();
}
