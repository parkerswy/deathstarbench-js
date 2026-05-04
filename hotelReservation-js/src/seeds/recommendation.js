export async function seedRecommendationDatabase(client) {
  const hotels = [
    { hotelId: '1', lat: 37.7867, lon: -122.4112, rate: 109, price: 150 },
    { hotelId: '2', lat: 37.7854, lon: -122.4005, rate: 139, price: 120 },
    { hotelId: '3', lat: 37.7834, lon: -122.4071, rate: 109, price: 190 },
    { hotelId: '4', lat: 37.7936, lon: -122.393, rate: 129, price: 160 },
    { hotelId: '5', lat: 37.7831, lon: -122.4181, rate: 119, price: 140 },
    { hotelId: '6', lat: 37.7863, lon: -122.4015, rate: 149, price: 200 }
  ];

  for (let i = 7; i <= 80; i += 1) {
    let rate = 135;
    let price = 179;
    if (i % 3 === 0) {
      switch (i % 5) {
        case 1:
          rate = 120;
          price = 140;
          break;
        case 2:
          rate = 124;
          price = 144;
          break;
        case 3:
          rate = 132;
          price = 158;
          break;
        case 4:
          rate = 232;
          price = 258;
          break;
        default:
          rate = 109;
          price = 123.17;
          break;
      }
    }

    hotels.push({
      hotelId: `${i}`,
      lat: 37.7835 + (i / 500) * 3,
      lon: -122.41 + (i / 500) * 4,
      rate,
      price
    });
  }

  await client.db('recommendation-db').collection('recommendation').insertMany(hotels);
}
