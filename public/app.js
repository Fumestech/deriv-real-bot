let ws = null;
let prices = [];
let running = false;
let lastEntry = 0;
let tradesToday = 0;
let pnlToday = 0;

const $ = id => document.getElementById(id);

function log(message) {
  $("log").innerHTML =
    `<div>${new Date().toLocaleTimeString()} — ${message}</div>` +
    $("log").innerHTML;
}

async function session() {
  try {
    const r = await fetch("/api/session");
    const s = await r.json();

    $("auth").textContent = s.authenticated
      ? "Logged in"
      : "Not logged in";

    $("auth").className =
      "badge " + (s.authenticated ? "ok" : "");

    $("login").textContent =
      s.authenticated ? "Deriv connected" : "Login with Deriv";

  } catch (e) {
    log("Could not check login status");
  }
}

$("login").onclick = () => {
  location.href = "/auth/login";
};

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let value =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    value =
      values[i] * multiplier +
      value * (1 - multiplier);
  }

  return value;
}

function rsi(values, period) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const difference = values[i] - values[i - 1];

    if (difference > 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  if (losses === 0) return 100;

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
}

function getSignal() {
  const fast = ema(
    prices,
    Number($("fast").value)
  );

  const slow = ema(
    prices,
    Number($("slow").value)
  );

  const rsiValue = rsi(
    prices,
    Number($("rsi").value)
  );

  if (
    fast === null ||
    slow === null ||
    rsiValue === null
  ) {
    return null;
  }

  const trigger = Number($("trigger").value);

  if (
    fast > slow &&
    rsiValue >= trigger
  ) {
    return "CALL";
  }

  if (
    fast < slow &&
    rsiValue <= 100 - trigger
  ) {
    return "PUT";
  }

  return null;
}

async function connect() {
  if (running) return;

  const accountId =
    $("account").value.trim();

  const accountType =
    $("accountType").value;

  if (!accountId) {
    alert("Enter your Deriv account ID first.");
    return;
  }

  if (
    accountType === "real" &&
    !$("liveConfirm").checked
  ) {
    alert("Confirm real-money risk first.");
    return;
  }

  try {
    const response = await fetch("/api/otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        accountId,
        accountType
      })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(
        data.error ||
        JSON.stringify(data)
      );
      return;
    }

    if (!data.wsUrl) {
      alert("Deriv did not return a WebSocket URL.");
      return;
    }

    ws = new WebSocket(data.wsUrl);
    running = true;

    ws.onopen = () => {
      log("Authenticated WebSocket connected.");

      ws.send(JSON.stringify({
        ticks: $("symbol").value,
        subscribe: 1,
        req_id: 1
      }));
    };

    ws.onmessage = event => {
      try {
        handle(JSON.parse(event.data));
      } catch (e) {
        log("Invalid server response.");
      }
    };

    ws.onclose = () => {
      running = false;
      log("WebSocket closed.");
    };

    ws.onerror = () => {
      log("WebSocket error.");
    };

  } catch (error) {
    running = false;
    alert("Connection failed: " + error.message);
  }
}

function handle(data) {

  if (data.msg_type === "tick") {

    const price = Number(data.tick.quote);

    prices.push(price);

    if (prices.length > 300) {
      prices.shift();
    }

    $("price").textContent = price;

    const signal = getSignal();

    $("signal").textContent =
      signal || "WAIT";

    if (
      $("auto").checked &&
      signal &&
      Date.now() - lastEntry > 15000
    ) {
      trade(signal);
    }
  }

  if (data.msg_type === "proposal") {

    log(
      "Proposal received: " +
      (data.proposal?.id || "")
    );
  }

  if (data.msg_type === "buy") {

    tradesToday++;

    log(
      "BUY accepted: " +
      (data.buy?.contract_id || "")
    );

    if (data.buy?.contract_id) {

      ws.send(JSON.stringify({
        proposal_open_contract: 1,
        contract_id: data.buy.contract_id,
        subscribe: 1,
        req_id: 100 + tradesToday
      }));
    }
  }

  if (
    data.msg_type ===
    "proposal_open_contract"
  ) {

    const contract =
      data.proposal_open_contract;

    if (!contract) return;

    log(
      `Contract ${contract.contract_id}: ` +
      `${contract.status || ""} ` +
      `P/L ${contract.profit ?? ""}`
    );

    if (
      contract.is_sold ||
      contract.status === "sold"
    ) {

      const profit =
        Number(contract.profit) || 0;

      pnlToday += profit;
    }
  }

  if (data.error) {
    log(
      "ERROR: " +
      data.error.message
    );
  }
}

function trade(side) {

  if (
    tradesToday >=
    Number($("maxTrades").value)
  ) {
    $("auto").checked = false;
    log("Maximum trades reached.");
    return;
  }

  if (
    pnlToday <=
    -Number($("maxLoss").value)
  ) {
    $("auto").checked = false;
    log("Daily loss limit reached.");
    return;
  }

  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  const amount =
    Number($("stake").value);

  const duration =
    Number($("duration").value);

  lastEntry = Date.now();

  const proposalRequest = {
    proposal: 1,
    amount,
    basis: "stake",
    contract_type: side,
    currency: "USD",
    duration,
    duration_unit: "s",
    underlying_symbol: $("symbol").value,
    req_id: 2
  };

  ws.send(
    JSON.stringify(proposalRequest)
  );

  log(
    `Signal ${side} — requesting proposal.`
  );
}

$("start").onclick = connect;

$("stop").onclick = () => {

  if (ws) {
    ws.close();
  }

  running = false;

  log("Bot stopped.");
};

session();
