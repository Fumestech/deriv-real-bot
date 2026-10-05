import express from "express";
import session from "express-session";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 10000;
const CLIENT_ID = process.env.DERIV_CLIENT_ID;
const REDIRECT_URI = process.env.DERIV_REDIRECT_URI;
const ALLOW_REAL = process.env.ALLOW_REAL_TRADING === "true";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 3600000
    }
  })
);

app.use(express.static("public"));

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function createVerifier() {
  return base64url(crypto.randomBytes(48));
}

async function createChallenge(verifier) {
  return base64url(
    crypto
      .createHash("sha256")
      .update(verifier)
      .digest()
  );
}

app.get("/auth/login", async (req, res) => {
  try {
    if (!CLIENT_ID || !REDIRECT_URI) {
      return res
        .status(500)
        .send("Deriv OAuth environment variables are missing.");
    }

    const verifier = createVerifier();
    const challenge = await createChallenge(verifier);
    const state = base64url(crypto.randomBytes(24));

    req.session.pkce = verifier;
    req.session.oauthState = state;

    const url = new URL(
      "https://auth.deriv.com/oauth2/auth"
    );

    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", "trade");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set(
      "code_challenge_method",
      "S256"
    );

    res.redirect(url.toString());
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get("/callback", async (req, res) => {
  try {
    if (
      !req.query.code ||
      req.query.state !== req.session.oauthState
    ) {
      return res
        .status(400)
        .send("Invalid OAuth callback.");
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: req.query.code,
      code_verifier: req.session.pkce,
      redirect_uri: REDIRECT_URI
    });

    const response = await fetch(
      "https://auth.deriv.com/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json(data);
    }

    req.session.accessToken = data.access_token;

    req.session.expiresAt =
      Date.now() +
      (data.expires_in || 3600) * 1000;

    delete req.session.pkce;
    delete req.session.oauthState;

    res.redirect("/");
  } catch (error) {
    res.status(500).send(
      "OAuth error: " + error.message
    );
  }
});

app.get("/api/session", (req, res) => {
  res.json({
    authenticated: !!req.session.accessToken,
    expiresAt:
      req.session.expiresAt || null,
    allowReal: ALLOW_REAL
  });
});

app.post("/api/otp", async (req, res) => {
  try {
    if (!req.session.accessToken) {
      return res
        .status(401)
        .json({ error: "Login required" });
    }

    if (
      req.session.expiresAt &&
      req.session.expiresAt < Date.now()
    ) {
      return res
        .status(401)
        .json({ error: "Session expired" });
    }

    const accountId =
      String(req.body.accountId || "");

    const accountType =
      req.body.accountType === "real"
        ? "real"
        : "demo";

    if (
      !/^[A-Za-z0-9_-]{3,64}$/.test(accountId)
    ) {
      return res
        .status(400)
        .json({ error: "Invalid account ID" });
    }

    if (
      accountType === "real" &&
      !ALLOW_REAL
    ) {
      return res.status(403).json({
        error:
          "Real trading is disabled. Test with a demo account first."
      });
    }

    const url =
      `https://api.derivws.com/trading/v1/options/accounts/` +
      `${encodeURIComponent(accountId)}/otp`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${req.session.accessToken}`
      }