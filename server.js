import express from "express";
import session from "express-session";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false
}));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/session", (req, res) => {
  res.json({
    authenticated: false,
    allowReal: false
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Deriv bot running on port " + PORT);
});