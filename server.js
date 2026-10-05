import express from "express";
import session from "express-session";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 10000;
const CLIENT_ID = process.env.DERIV_CLIENT_ID;
const REDIRECT_URI = process.env.DERIV_REDIRECT_URI;
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const ALLOW_REAL_TRADING =
  process.env.ALLOW_REAL_TRADING === "true";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/*
  Normal application session.
*/
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 1000
    }
  })
);

app.use(express.static("public"));

/*
  -----------------------------
  Helpers
  -----------------------------
*/

function base64url(data) {
  return Buffer.from(data).toString("base64url");
}

function createVerifier() {
  return base64url(crypto.randomBytes(48));
}

function createChallenge(verifier) {
  return base64url(
    crypto
      .createHash("sha256")
      .update(verifier)
      .digest()
  );
}

function createState() {
  return base64url(crypto.randomBytes(32));
}

function signValue(value) {
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("base64url");

  return `${value}.${signature}`;
}

function verifyValue(signedValue) {
  if (!signedValue) return null;

  const index = signedValue.lastIndexOf(".");
  if (index === -1) return null;

  const value = signedValue.slice(0, index);
  const signature = signedValue.slice(index + 1);

  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(value)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    return null;
  }

  return value;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function setCookie(res, name, value, maxAge) {
  res.setHeader(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
}

function clearCookie(res, name) {
  res.append(
    "Set-Cookie",
    `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
}

/*
  -----------------------------
  Health check
  -----------------------------
*/

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Deriv Trading Bot",
    oauthConfigured: Boolean(
      CLIENT_ID && REDIRECT_URI
    )
  });
});

/*
  -----------------------------
  Deriv OAuth login
  -----------------------------
*/

app.get("/auth/login", (req, res) => {
  try {
    if (!CLIENT_ID || !REDIRECT_URI) {
      return res.status(500).send(
        "Deriv OAuth configuration is missing on the server."
      );
    }

    const verifier = createVerifier();
    const challenge = createChallenge(verifier);
    const state = createState();

    /*
      Store OAuth information in signed cookies.
      This prevents the callback from depending on
      the temporary Render session store.
    */
    setCookie(
      res,
      "deriv_oauth_verifier",
      signValue(verifier),
      600
    );

    setCookie(
      res,
      "deriv_oauth_state",
      signValue(state),
      600
    );

    const url = new URL(
      "https://auth.deriv.com/oauth2/auth"
    );

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", "trade");
    url.searchParams.set("state", state);
    url.searchParams.set(
      "code_challenge",
      challenge
    );
    url.searchParams.set(
      "code_challenge_method",
      "S256"
    );

    console.log(
      "Starting Deriv OAuth:",
      REDIRECT_URI
    );

    res.redirect(url.toString());
  } catch (error) {
    console.error("OAuth start error:", error);

    res.status(500).send(
      "Unable to start Deriv login."
    );
  }
});

/*
  -----------------------------
  OAuth callback
  -----------------------------
*/

app.get("/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const returnedState = String(
      req.query.state || ""
    );

    /*
      Deriv may return an OAuth error instead of a code.
    */
    if (req.query.error) {
      return res.status(400).send(
        `Deriv OAuth error: ${req.query.error}`
      );
    }

    if (!code) {
      return res.status(400).send(
        "OAuth callback did not contain an authorization code."
      );
    }

    const cookies = parseCookies(req);

    const savedState = verifyValue(
      cookies.deriv_oauth_state
    );

    const verifier = verifyValue(
      cookies.deriv_oauth_verifier
    );

    if (!savedState) {
      return res.status(400).send(
        "OAuth state cookie is missing or expired. Please start Login with Deriv again."
      );
    }

    if (!verifier) {
      return res.status(400).send(
        "OAuth verifier is missing or expired. Please start Login with Deriv again."
      );
    }

    if (
      !returnedState ||
      returnedState !== savedState
    ) {
      return res.status(400).send(
        "OAuth state mismatch. Please start Login with Deriv again."
      );
    }

    /*
      Exchange authorization code for access