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
  process.env.SESSION_SECRET || "change-this-secret";

const ALLOW_REAL =
  process.env.ALLOW_REAL_TRADING === "true";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set("trust proxy", 1);

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60 * 60 * 1000
    }
  })
);

app.use(express.static("public"));

function randomString() {
  return crypto.randomBytes(32).toString("hex");
}

function challenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Deriv Trading Bot"
  });
});

app.get("/auth/login", (req, res) => {
  if (!CLIENT_ID || !REDIRECT_URI) {
    return res.status(500).send(
      "OAuth configuration is missing."
    );
  }

  const verifier = randomString();
  const state = randomString();

  req.session.oauthVerifier = verifier;
  req.session.oauthState = state;

  req.session.save((err) => {
    if (err) {
      console.error(err);
      return res.status(500).send(
        "Could not start OAuth session."
      );
    }

    const url = new URL(
      "https://auth.deriv.com/oauth2/auth"
    );

    url.searchParams.set(
      "response_type",
      "code"
    );

    url.searchParams.set(
      "client_id",
      CLIENT_ID
    );

    url.searchParams.set(
      "redirect_uri",
      REDIRECT_URI
    );

    url.searchParams.set(
      "scope",
      "trade"
    );

    url.searchParams.set(
      "state",
      state
    );

    url.searchParams.set(
      "code_challenge",
      challenge(verifier)
    );

    url.searchParams.set(
      "code_challenge_method",