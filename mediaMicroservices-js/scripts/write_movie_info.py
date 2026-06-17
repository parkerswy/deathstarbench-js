import aiohttp
import asyncio
import json
import argparse

REQUEST_RETRIES = 3

async def post(session, url, **kwargs):
  for attempt in range(REQUEST_RETRIES):
    try:
      async with session.post(url, **kwargs) as resp:
        return resp.status, await resp.text()
    except (aiohttp.ClientError, asyncio.TimeoutError) as error:
      if attempt + 1 == REQUEST_RETRIES:
        return 0, str(error)
      await asyncio.sleep(0.1 * (attempt + 1))

async def upload_cast_info(session, addr, cast):
  return await post(session, addr + "/wrk2-api/cast-info/write", json=cast)

async def upload_plot(session, addr, plot):
  return await post(session, addr + "/wrk2-api/plot/write", json=plot)

async def upload_movie_info(session, addr, movie):
  return await post(session, addr + "/wrk2-api/movie-info/write", json=movie)

async def register_movie(session, addr, movie):
  params = {
    "title": movie["title"],
    "movie_id": movie["movie_id"]
  }
  return await post(session, addr + "/wrk2-api/movie/register", data=params)

async def finish_batch(tasks, completed, label):
  results = await asyncio.gather(*tasks)
  failures = sum(1 for status, _ in results if status < 200 or status >= 300)
  suffix = f" ({failures} existing/failed writes)" if failures else ""
  print(completed, label, "finished" + suffix)
  return failures

async def write_cast_info(addr, raw_casts, concurrency):
  idx = 0
  tasks = []
  failures = 0
  conn = aiohttp.TCPConnector(limit=concurrency)
  async with aiohttp.ClientSession(connector=conn) as session:
    for raw_cast in raw_casts:
      try:
        cast = dict()
        cast["cast_info_id"] = raw_cast["id"]
        cast["name"] = raw_cast["name"]
        cast["gender"] = True if raw_cast["gender"] == 2 else False
        cast["intro"] = raw_cast["biography"]
        task = asyncio.ensure_future(upload_cast_info(session, addr, cast))
        tasks.append(task)
        idx += 1
      except:
        print("Warning: cast info missing!")
      if len(tasks) >= concurrency:
        failures += await finish_batch(tasks, idx, "casts")
        tasks = []
    if tasks:
      failures += await finish_batch(tasks, idx, "casts")
  return failures

async def write_movie_info(addr, raw_movies, concurrency, register_movies_only):
  idx = 0
  tasks = []
  failures = 0
  conn = aiohttp.TCPConnector(limit=concurrency)
  async with aiohttp.ClientSession(connector=conn) as session:
    for raw_movie in raw_movies:
      movie = dict()
      casts = list()
      movie["movie_id"] = str(raw_movie["id"])
      movie["title"] = raw_movie["title"]
      movie["plot_id"] = raw_movie["id"]
      for raw_cast in raw_movie["cast"]:
        try:
          cast = dict()
          cast["cast_id"] = raw_cast["cast_id"]
          cast["character"] = raw_cast["character"]
          cast["cast_info_id"] = raw_cast["id"]
          casts.append(cast)
        except:
          print("Warning: cast info missing!")
      movie["casts"] = casts
      movie["thumbnail_ids"] = [raw_movie["poster_path"]]
      movie["photo_ids"] = []
      movie["video_ids"] = []
      movie["avg_rating"] = raw_movie["vote_average"]
      movie["num_rating"] = raw_movie["vote_count"]
      if not register_movies_only:
        task = asyncio.ensure_future(upload_movie_info(session, addr, movie))
        tasks.append(task)
        plot = dict()
        plot["plot_id"] = raw_movie["id"]
        plot["plot"] = raw_movie["overview"]
        task = asyncio.ensure_future(upload_plot(session, addr, plot))
        tasks.append(task)
      task = asyncio.ensure_future(register_movie(session, addr, movie))
      tasks.append(task)
      idx += 1
      if len(tasks) >= concurrency:
        failures += await finish_batch(tasks, idx, "movies")
        tasks = []
    if tasks:
      failures += await finish_batch(tasks, idx, "movies")
  return failures

async def seed(addr, raw_casts, raw_movies, concurrency, skip_casts, register_movies_only):
  failures = 0
  if not skip_casts and not register_movies_only:
    failures += await write_cast_info(addr, raw_casts, concurrency)
  failures += await write_movie_info(addr, raw_movies, concurrency, register_movies_only)
  if failures:
    print(f"Finished with {failures} existing or failed writes; reruns report duplicates.")

if __name__ == '__main__':
  parser = argparse.ArgumentParser()
  parser.add_argument("-c", "--cast", action="store", dest="cast_filename",
    type=str, default="../datasets/tmdb/casts.json")
  parser.add_argument("-m", "--movie", action="store", dest="movie_filename",
    type=str, default="../datasets/tmdb/movies.json")
  parser.add_argument("--server_address", action="store", dest="server_addr",
    type=str, default="http://127.0.0.1:8080")
  parser.add_argument("--concurrency", action="store", type=int, default=16,
    help="maximum simultaneous setup requests")
  parser.add_argument("--skip-casts", action="store_true",
    help="skip cast metadata while uploading movie and plot metadata")
  parser.add_argument("--register-movies-only", action="store_true",
    help="only register TMDB movie titles required by compose-review workload")
  args = parser.parse_args()

  if args.concurrency < 1:
    parser.error("--concurrency must be at least 1")
  raw_casts = []
  if not args.skip_casts and not args.register_movies_only:
    with open(args.cast_filename, 'r') as cast_file:
      raw_casts = json.load(cast_file)
  with open(args.movie_filename, 'r') as movie_file:
    raw_movies = json.load(movie_file)

  asyncio.run(seed(args.server_addr, raw_casts, raw_movies, args.concurrency,
    args.skip_casts, args.register_movies_only))
