export async function seedReservationDatabase(client) {
  await client.db('reservation-db').collection('reservation').insertMany([
    {
      hotelId: '4',
      customerName: 'Alice',
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      number: 1
    }
  ]);

  const roomNumbers = [
    { hotelId: '1', numberOfRoom: 200 },
    { hotelId: '2', numberOfRoom: 200 },
    { hotelId: '3', numberOfRoom: 200 },
    { hotelId: '4', numberOfRoom: 200 },
    { hotelId: '5', numberOfRoom: 200 },
    { hotelId: '6', numberOfRoom: 200 }
  ];

  for (let i = 7; i <= 80; i += 1) {
    let numberOfRoom = 200;
    if (i % 3 === 1) {
      numberOfRoom = 300;
    } else if (i % 3 === 2) {
      numberOfRoom = 250;
    }

    roomNumbers.push({
      hotelId: `${i}`,
      numberOfRoom
    });
  }

  await client.db('reservation-db').collection('number').insertMany(roomNumbers);
}
