# Project: "Rave Dad" AI Music Community Bot
**Goal:** A "Critique-to-Earn" Discord bot that incentivizes listening to AI music submissions.

## 1. Tech Stack
- **Runtime:** Node.js
- **Library:** Discord.js (v14+)
- **Database:** `better-sqlite3` (SQLite)
- **Config:** `dotenv` for tokens

## 2. Database Schema
**Table: Users**
- `id` (Text, PK)
- `credits` (Int) - Spending currency.
- `lifetime_points` (Int) - For Leaderboard.
- `daily_points` (Int) - Reset daily.
- `last_active` (ISO Date)

**Table: Songs**
- `id` (Int, PK, Auto-inc)
- `user_id` (Text)
- `url` (Text)
- `description` (Text, 100 chars)
- `tags` (Text/JSON) - Stores `["Macro: EDM", "Micro: Techno", ...]`
- `upvotes` (Int)
- `timestamp` (Int)

**Table: Votes**
- `id` (Int, PK)
- `song_id` (Int)
- `voter_id` (Text)
- `type` (Enum: 'REVIEW', 'UPVOTE')
- `timestamp` (Int)

## 3. The Submission Flow (Critical)
**Trigger:** `/submit`
1. **Modal Interaction:** Bot opens a Form.
   - Field A: `Link` (YouTube/Suno/Spotify).
   - Field B: `Description` (Text, max 100 chars).
2. **Keyword Filter:** Check `Description` against a `banned_words.json`. If match -> Reject.
3. **Select Menu 1 (Primary):** User picks 1 of 15 Macro Genres (e.g., "Electronic: House/Techno").
4. **Select Menu 2 (Micro):** Based on Menu 1, show specific sub-genres (e.g., "Acid", "Deep House").
5. **Select Menu 3 (Secondary - Optional):** Repeat Macro selection or "Skip".
6. **Select Menu 4 (Micro - Optional):** Repeat Micro selection.
7. **Finalize:** Save to DB and post Embed to `#fresh-drops`.

## 4. The "Critique-to-Earn" Logic
**The Time-Gate:**
1. User clicks "🎧 Listen" on an embed.
2. Bot starts a generic timer (timestamp).
3. User clicks "⭐ Rate/Review".
4. **Check:** If `(Now - StartTime) < 45s` -> Reject with "Please listen longer."

**The Reward:**
1. User submits review (Modal).
2. **Check:** Word count >= 5 words.
3. **Check:** `User.daily_points` < 20.
   - If Pass: `User.credits` +1, `User.lifetime` +1.
   - If Fail (Cap Reached): No points, but review posts.

## 5. The Voting Economy (Tiered)
**Trigger:** `/upvote [song_id]`
- **Cost:** 1 Credit per vote.
- **Self-Vote Rule:** Max 1 vote allowed on own songs.
- **Community-Vote Rule:** Max 3 votes allowed on other songs.
- **Logic:** Query `Votes` table to count existing votes by `user_id` on `song_id` before allowing.

## 6. Data Taxonomy (Macro Genres)
*Hard-code these 15 Macros in a `taxonomy.json` file:*
1. EDM: House & Techno
2. EDM: Trance & Synth
3. EDM: Bass & Breakbeat
4. Rock: Classic & Hard
5. Rock: Metal & Heavy
6. Rock: Indie & Alt
7. Hip Hop & Rap
8. Pop & R&B
9. Latin & Reggae
10. Country: Modern & Pop
11. Country: Trad & Folk
12. Jazz & Blues
13. Cinematic & Score
14. World & International
15. Experimental & AI

## 7. Safety Features
- **Report Button:** On every song embed. Clicking it sends a copy of the song + reason to `#mod-queue`.