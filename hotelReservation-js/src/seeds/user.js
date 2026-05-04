import crypto from 'node:crypto';

export async function seedUserDatabase(client) {
  const users = [];

  for (let i = 0; i <= 500; i += 1) {
    const suffix = `${i}`;
    let password = '';
    for (let j = 0; j < 10; j += 1) {
      password += suffix;
    }

    const hash = crypto.createHash('sha256').update(password).digest('hex');
    const username = `Cornell_${Buffer.from(suffix, 'utf8').toString('hex')}`;
    users.push({
      username,
      password: hash
    });
  }

  await client.db('user-db').collection('user').insertMany(users);
}
