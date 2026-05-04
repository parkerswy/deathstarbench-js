export async function seedGeoDatabase(client) {
  const points = [
    { hotelId: '1', lat: 37.7867, lon: -122.4112 },
    { hotelId: '2', lat: 37.7854, lon: -122.4005 },
    { hotelId: '3', lat: 37.7854, lon: -122.4071 },
    { hotelId: '4', lat: 37.7936, lon: -122.393 },
    { hotelId: '5', lat: 37.7831, lon: -122.4181 },
    { hotelId: '6', lat: 37.7863, lon: -122.4015 }
  ];

  for (let i = 7; i <= 80; i += 1) {
    points.push({
      hotelId: `${i}`,
      lat: 37.7835 + (i / 500) * 3,
      lon: -122.41 + (i / 500) * 4
    });
  }

  await client.db('geo-db').collection('geo').insertMany(points);
}
