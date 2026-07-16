# Getting the app online — step by step

No coding needed for this part. Just following steps and clicking buttons.
I'll explain what each thing is as we go.

---

## Step 1: Create a free GitHub account (this is just where the code "lives")

1. Go to https://github.com and click "Sign up"
2. Use your business email
3. Once signed up, click the "+" icon top-right → "New repository"
4. Name it `our-own-ready-mix-app`
5. Leave everything else default, click "Create repository"

## Step 2: Upload the code to GitHub (no command line needed)

1. Unzip the `oorm-app.zip` file I gave you on your computer
2. On your new GitHub repository page, click "uploading an existing file"
3. Drag the unzipped folder's contents in (backend, frontend, README.md, render.yaml)
4. Scroll down, click "Commit changes"

That's it — your code is now safely stored online, which is also a form of backup.

## Step 3: Create a free Render account (this is where the app will actually run)

1. Go to https://render.com and click "Get Started"
2. Sign up using your GitHub account (there's a "Sign up with GitHub" button — easiest option)
3. Once in, click "New +" → "Blueprint"
4. Connect it to the `our-own-ready-mix-app` repository you just created
5. Render will read the `render.yaml` file already included in the code, and automatically
   set up three things for you: the database, the backend, and the frontend
6. Click "Apply" — Render will start building everything. This takes a few minutes.

## Step 4: Set up the database tables

Once Render shows your database as "Available":

1. Click on the database (named `oorm-db`) in your Render dashboard
2. Find the "Connect" section — copy the "PSQL Command" shown there
3. You'll need someone to run one command using that connection info to load the tables
   from `backend/schema.sql`. If you don't have anyone technical for this one step, let me
   know once you're at this point and I can walk you through it directly, or you can ask
   Render's support chat — this is a very common, well-documented step for them.

## Step 5: Create your first login

Similarly, running `node src/seed.js` once (pointed at your new database) creates your
first Administrator account. I can guide you through this exact step when you get there —
it's a single command, copy-pasted.

## Step 6: Open the app

Once everything shows "Live" in Render, your frontend will have a web address like:
`https://oorm-frontend.onrender.com`

Open that on any phone or computer, and for phones: tap the browser's menu → "Add to Home
Screen" — that's the installable app, no app store needed.

---

## Costs to expect

Render's free tier works for testing, but free databases pause after inactivity and free
web services sleep when idle (meaning the first person to open the app each morning might
wait ~30 seconds for it to "wake up"). For a real business daily-use app, you'd want their
paid "Starter" tier once you're ready to go live with your team — roughly $7/month for the
backend plus around $7-19/month for the database, landing close to the $25-70/month
estimate I gave you earlier.

## When you're stuck

Come back to me at any point in these steps and tell me exactly what you're looking at on
screen — I can guide you through the specific button or field even without seeing it.
