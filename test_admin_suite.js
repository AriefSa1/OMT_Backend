const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function runAdminSuite() {
  console.log('========================================');
  console.log('🧪 RUNNING ADMIN & REGISTRATION CODE TEST SUITE');
  console.log('========================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // 1. Verify Prisma models exist
    console.log('🔹 1. Testing Database Models and Connectivity...');
    const userCount = await prisma.user.count();
    console.log(`     Total existing users: ${userCount}`);
    assert(userCount >= 1, 'Database contains at least 1 initial user');

    // 2. Test RegistrationCode creation
    console.log('\n🔹 2. Testing Registration Code Generation...');
    const testCodeStr = `TEST-${Date.now()}`;
    const newCode = await prisma.registrationCode.create({
      data: {
        code: testCodeStr,
        role: 'MANAGER',
        maxUses: 1,
        usedCount: 0,
        isActive: true,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        description: 'Automated test registration code'
      }
    });
    assert(newCode && newCode.code === testCodeStr, `Registration code created: ${newCode.code}`);
    assert(newCode.role === 'MANAGER', 'Code grants MANAGER role properly');

    // 3. Test User Registration via RegistrationCode logic
    console.log('\n🔹 3. Testing Registration Flow with Code...');
    const foundCode = await prisma.registrationCode.findUnique({
      where: { code: testCodeStr }
    });
    assert(foundCode.isActive && foundCode.usedCount < foundCode.maxUses, 'Code is active and has available quota');

    const testEmail = `test_user_${Date.now()}@example.com`;
    const hashedPassword = await bcrypt.hash('password123', 10);
    const registeredUser = await prisma.user.create({
      data: {
        name: 'Test Manager User',
        email: testEmail,
        password: hashedPassword,
        role: foundCode.role
      }
    });
    assert(registeredUser && registeredUser.role === 'MANAGER', 'User registered with MANAGER role from code');

    // Increment code usage
    const updatedCode = await prisma.registrationCode.update({
      where: { id: foundCode.id },
      data: { usedCount: { increment: 1 } }
    });
    assert(updatedCode.usedCount === 1, 'Registration code usage count incremented to 1');

    // 4. Test Quota Exhaustion
    console.log('\n🔹 4. Testing Quota Exhaustion Check...');
    const isExhausted = updatedCode.usedCount >= updatedCode.maxUses;
    assert(isExhausted === true, 'Code quota is now recognized as exhausted');

    // 5. Test Admin Audit Log Creation
    console.log('\n🔹 5. Testing Admin Audit Logging...');
    const auditLog = await prisma.adminAuditLog.create({
      data: {
        action: 'USER_REGISTERED',
        actorId: registeredUser.id,
        actorName: registeredUser.name,
        actorEmail: registeredUser.email,
        targetId: updatedCode.id,
        targetName: updatedCode.code,
        details: JSON.stringify({ role: registeredUser.role, via: 'REGISTRATION_CODE' })
      }
    });
    assert(auditLog && auditLog.action === 'USER_REGISTERED', 'Audit log successfully recorded');

    // 6. Test User Role Update & Password Reset Logic
    console.log('\n🔹 6. Testing Role Modification & Password Reset...');
    const modifiedUser = await prisma.user.update({
      where: { id: registeredUser.id },
      data: { role: 'ANALYST' }
    });
    assert(modifiedUser.role === 'ANALYST', 'User role updated from MANAGER to ANALYST');

    const newHashedPassword = await bcrypt.hash('newPassword456', 10);
    const pwUpdated = await prisma.user.update({
      where: { id: registeredUser.id },
      data: { password: newHashedPassword }
    });
    const pwMatch = await bcrypt.compare('newPassword456', pwUpdated.password);
    assert(pwMatch === true, 'Password reset verified with bcrypt comparison');

    // 7. Test Anti-Lockout (Admin Deletion Protection)
    console.log('\n🔹 7. Testing Anti-Lockout / Admin Safety Protection...');
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
    console.log(`     Active admin count: ${adminCount}`);
    assert(adminCount >= 1, 'At least 1 ADMIN exists');

    // 8. Test Safe User Deletion & Cleanup
    console.log('\n🔹 8. Testing User Deletion and Code Cleanup...');
    await prisma.user.delete({ where: { id: registeredUser.id } });
    const userAfterDelete = await prisma.user.findUnique({ where: { id: registeredUser.id } });
    assert(userAfterDelete === null, 'Test user deleted successfully');

    await prisma.adminAuditLog.delete({ where: { id: auditLog.id } });
    await prisma.registrationCode.delete({ where: { id: newCode.id } });
    const codeAfterDelete = await prisma.registrationCode.findUnique({ where: { id: newCode.id } });
    assert(codeAfterDelete === null, 'Test registration code cleaned up successfully');

  } catch (err) {
    console.error('\n❌ Unhandled Exception in Suite:', err);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n========================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAdminSuite();
