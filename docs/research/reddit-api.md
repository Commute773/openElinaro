# Reddit Free JSON API

Reddit exposes a free, unauthenticated JSON API by appending `.json` to any Reddit URL. No API key or OAuth required — just a custom User-Agent header.

## Base Pattern

```
https://www.reddit.com/{path}.json?{params}
```

Always send a User-Agent header (Reddit blocks the default `curl` UA):
```
User-Agent: OpenElinaro/1.0
```

## Endpoints

### Subreddit Hot/New/Top Posts
```
GET /r/{subreddit}/hot.json?limit=25
GET /r/{subreddit}/new.json?limit=25
GET /r/{subreddit}/top.json?t=day&limit=25    # t = hour|day|week|month|year|all
```

### Search Within a Subreddit
```
GET /r/{subreddit}/search.json?q={query}&restrict_sr=on&sort=relevance&t=all&limit=25
```

### Global Search
```
GET /search.json?q={query}&sort=relevance&t=all&limit=25
```

### Post + Comments
```
GET /r/{subreddit}/comments/{post_id}.json
```
Returns an array of two Listings: `[post, comments]`.

### User Profile / Posts
```
GET /user/{username}/submitted.json?limit=25&sort=new
GET /user/{username}/comments.json?limit=25&sort=new
GET /user/{username}/about.json
```

## Pagination

All listing endpoints return `data.after` and `data.before` cursors:
```
GET /r/{subreddit}/hot.json?limit=25&after={after_token}
```

## Response Shape

```json
{
  "kind": "Listing",
  "data": {
    "after": "t3_abc123",
    "children": [
      {
        "kind": "t3",
        "data": {
          "title": "...",
          "selftext": "...",
          "author": "...",
          "ups": 276,
          "num_comments": 32,
          "url": "...",
          "created_utc": 1711612800,
          "subreddit": "LocalLLaMA",
          "permalink": "/r/LocalLLaMA/comments/..."
        }
      }
    ]
  }
}
```

Key fields per post (`t3`):
- `title`, `selftext` (body text), `author`, `ups`, `num_comments`
- `url` (link posts), `permalink` (reddit link), `created_utc`
- `is_self` (true = text post), `link_flair_text` (category tag)
- `over_18` (NSFW flag)

Key fields per comment (`t1`):
- `body`, `author`, `ups`, `created_utc`
- `replies` (nested Listing or empty string)

## Rate Limits

Unauthenticated: ~10 requests/minute (undocumented, observed).
Authenticated (OAuth): 60 requests/minute with a proper app registration.

For agent use at low volume (social lookup, topic search), unauthenticated is fine.

## Example: Fetch Hot Posts

```bash
curl -s -A "OpenElinaro/1.0" \
  "https://www.reddit.com/r/LocalLLaMA/hot.json?limit=5"
```

## Tested

- 2026-03-28: confirmed working, returns full JSON, no auth needed.
