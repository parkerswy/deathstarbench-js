export async function seedAttractionsDatabase(client) {
  const hotels = [
    { hotelId: '1', lat: 37.7867, lon: -122.4112 },
    { hotelId: '2', lat: 37.7854, lon: -122.4005 },
    { hotelId: '3', lat: 37.7854, lon: -122.4071 },
    { hotelId: '4', lat: 37.7936, lon: -122.393 },
    { hotelId: '5', lat: 37.7831, lon: -122.4181 },
    { hotelId: '6', lat: 37.7863, lon: -122.4015 }
  ];

  const restaurants = [
    {
      restaurantId: '1',
      lat: 37.7867,
      lon: -122.4112,
      restaurantName: 'R1',
      rating: 3.5,
      type: 'fusion'
    },
    {
      restaurantId: '2',
      lat: 37.7857,
      lon: -122.4012,
      restaurantName: 'R2',
      rating: 3.9,
      type: 'italian'
    },
    {
      restaurantId: '3',
      lat: 37.7847,
      lon: -122.3912,
      restaurantName: 'R3',
      rating: 4.5,
      type: 'sushi'
    },
    {
      restaurantId: '4',
      lat: 37.7862,
      lon: -122.4212,
      restaurantName: 'R4',
      rating: 3.2,
      type: 'sushi'
    },
    {
      restaurantId: '5',
      lat: 37.7839,
      lon: -122.4052,
      restaurantName: 'R5',
      rating: 4.9,
      type: 'fusion'
    },
    {
      restaurantId: '6',
      lat: 37.7831,
      lon: -122.3812,
      restaurantName: 'R6',
      rating: 4.1,
      type: 'american'
    }
  ];

  const museums = [
    { museumId: '1', lat: 35.7867, lon: -122.4112, museumName: 'M1', type: 'history' },
    { museumId: '2', lat: 36.7867, lon: -122.5112, museumName: 'M2', type: 'history' },
    { museumId: '3', lat: 38.7867, lon: -122.4612, museumName: 'M3', type: 'nature' },
    { museumId: '4', lat: 37.7867, lon: -122.4912, museumName: 'M4', type: 'nature' },
    { museumId: '5', lat: 36.9867, lon: -122.4212, museumName: 'M5', type: 'nature' },
    {
      museumId: '6',
      lat: 37.3867,
      lon: -122.5012,
      museumName: 'M6',
      type: 'technology'
    }
  ];

  const database = client.db('attractions-db');
  await database.collection('hotels').insertMany(hotels);
  await database.collection('restaurants').insertMany(restaurants);
  await database.collection('museums').insertMany(museums);
}
