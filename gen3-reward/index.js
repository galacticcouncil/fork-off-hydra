require("dotenv").config();
const BN = require("bn.js");
const { ApiPromise, WsProvider, Keyring } = require("@polkadot/api");
const { encodeAddress, cryptoWaitReady } = require("@polkadot/util-crypto");
const types = require("./types");
const { stringToU8a } = require("@polkadot/util");

const validators = require("../validators.json");
const nominators = require("../nominators.json");

const ACCOUNT_SECRET = process.env.ACCOUNT_SECRET || "//Alice";
const RPC = process.env.RPC_SERVER || "ws://127.0.0.1:9944";

const hdxToBN = (hdx) => new BN(hdx).mul(new BN(10).pow(new BN(12)));
const hdxAddress = (pubKey) => encodeAddress(pubKey, 63);

async function main() {
  await cryptoWaitReady();
  const provider = new WsProvider(RPC);
  const keyring = new Keyring({ type: "sr25519" });
  const api = await ApiPromise.create({
    types: types,
    typesAlias: {
      tokens: {
        AccountData: "OrmlAccountData",
      },
    },
  });

  const [chain, nodeVersion] = await Promise.all([
    api.rpc.system.chain(),
    api.rpc.system.version(),
  ]);
  console.log(`connected to ${RPC} (${chain} ${nodeVersion})`);

  const from = keyring.addFromUri(ACCOUNT_SECRET);
  console.log("sudo account:", hdxAddress(from.addressRaw));

  const treasuryPubKey = stringToU8a("modlpy/trsry".padEnd(32, "\0"));
  const TREASURY = hdxAddress(treasuryPubKey);
  console.log("treasury account:", TREASURY);

  const transfers = [
    ...validators.map((address) =>
      api.tx.balances.forceTransfer(TREASURY, address, hdxToBN(6000))
    ),
    ...nominators.map((address) =>
      api.tx.balances.forceTransfer(TREASURY, address, hdxToBN(1000))
    ),
  ];

  console.log("transfers generated:", transfers.length);

  const batch = api.tx.utility.batch(transfers);
  const sudo = api.tx.sudo.sudo(batch);

  if (process.argv[2] === "test") {
    console.log('run "npm start" to send tx');
    process.exit();
  }

  console.log("sending tx");
  await sudo.signAndSend(from, ({ events = [], status }) => {
    if (status.isInBlock) {
      console.log("included in block");
      console.log(
        "transfers executed:",
        events.filter(({ event: { method } }) => method === "Transfer").length
      );
    } else {
      console.log("tx: " + status.type);
    }
    if (status.type === "Finalized") {
      process.exit();
    }
    events
      .filter(({ event: { section } }) =>
        ["system", "utility", "sudo"].includes(section)
      )
      .forEach(({ event: { data, method, section } }) =>
        console.log(`event: ${section}.${method} ${data.toString()}`)
      );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit();
});
