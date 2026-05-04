export async function seedRateDatabase(client) {
  const ratePlans = [
    {
      hotelId: '1',
      code: 'RACK',
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomType: {
        bookableRate: 109,
        code: 'KNG',
        roomDescription: 'King sized bed',
        totalRate: 109,
        totalRateInclusive: 123.17
      }
    },
    {
      hotelId: '2',
      code: 'RACK',
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomType: {
        bookableRate: 139,
        code: 'QN',
        roomDescription: 'Queen sized bed',
        totalRate: 139,
        totalRateInclusive: 153.09
      }
    },
    {
      hotelId: '3',
      code: 'RACK',
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomType: {
        bookableRate: 109,
        code: 'KNG',
        roomDescription: 'King sized bed',
        totalRate: 109,
        totalRateInclusive: 123.17
      }
    }
  ];

  for (let i = 7; i <= 80; i += 1) {
    if (i % 3 !== 0) {
      continue;
    }

    let totalRate = 109;
    let totalRateInclusive = 123.17;
    if (i % 5 === 1) {
      totalRate = 120;
      totalRateInclusive = 140;
    } else if (i % 5 === 2) {
      totalRate = 124;
      totalRateInclusive = 144;
    } else if (i % 5 === 3) {
      totalRate = 132;
      totalRateInclusive = 158;
    } else if (i % 5 === 4) {
      totalRate = 232;
      totalRateInclusive = 258;
    }

    ratePlans.push({
      hotelId: `${i}`,
      code: 'RACK',
      inDate: '2015-04-09',
      outDate: i % 2 === 0 ? '2015-04-17' : '2015-04-24',
      roomType: {
        bookableRate: totalRate,
        code: 'KNG',
        roomDescription: 'King sized bed',
        totalRate,
        totalRateInclusive
      }
    });
  }

  await client.db('rate-db').collection('inventory').insertMany(ratePlans);
}
