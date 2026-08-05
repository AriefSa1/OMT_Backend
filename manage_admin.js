require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('./src/utils/prisma');

async function main() {
  try {
    const users = await prisma.user.findMany();
    console.log('\n=============================================');
    console.log('STATUS DATABASE USER:');
    console.log(`Total akun terdaftar: ${users.length}`);
    
    if (users.length > 0) {
      console.log('\nDaftar User:');
      users.forEach(u => {
        console.log(`- Email: ${u.email} | Nama: ${u.name} | Role: ${u.role}`);
      });

      // Update password for admin
      const targetAdmin = users.find(u => u.role === 'ADMIN') || users[0];
      const newPassword = 'Admin#2026!';
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      
      await prisma.user.update({
        where: { id: targetAdmin.id },
        data: { password: hashedPassword, role: 'ADMIN' }
      });

      console.log('\nAKSES LOGIN ADMIN DIPERBARUI:');
      console.log(`Email   : ${targetAdmin.email}`);
      console.log(`Password: ${newPassword}`);
      console.log(`Role    : ADMIN`);
    } else {
      console.log('\nBelum ada user di database Neon. Membuat akun Admin baru...');
      const newPassword = 'Admin#2026!';
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      const admin = await prisma.user.create({
        data: {
          name: 'Administrator',
          email: 'admin@94media.art',
          password: hashedPassword,
          role: 'ADMIN'
        }
      });

      console.log('\nAKSES LOGIN ADMIN BARU DIBUAT:');
      console.log(`Email   : ${admin.email}`);
      console.log(`Password: ${newPassword}`);
      console.log(`Role    : ${admin.role}`);
    }
    console.log('=============================================\n');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
