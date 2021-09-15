require("dotenv").config();
const BN = require("bn.js");
const fs = require("fs");
const {ApiPromise, WsProvider, Keyring} = require("@polkadot/api");
const {encodeAddress, cryptoWaitReady} = require("@polkadot/util-crypto");
const {types, typesAlias} = require("./types");
const {assert} = require("@polkadot/util");

const data = require("./data.json");

const ACCOUNT_SECRET = process.env.ACCOUNT_SECRET || "//Alice";
const RPC = process.env.RPC_SERVER || "ws://127.0.0.1:9944";

const hdxToBN = (hdx) => {
  const n = Math.trunc(hdx);
  const d = (hdx.toString().split('.')[1] || []).length;
  const r = Number((hdx - n).toFixed(d)) * 10 ** 12;
  return new BN(n).mul(new BN(10).pow(new BN(12))).add(new BN(r));
};

assert(111.111 === hdxToBN(111.111).toNumber() / 10 ** 12, 'wrong number conversion');
assert(1270.9946 === hdxToBN(1270.9946).toNumber() / 10 ** 12, 'wrong number conversion');
assert(new BN('100000382700000000').eq(hdxToBN(100000.3827)), 'wrong number conversion');

const hdxAddress = (pubKey) => encodeAddress(pubKey, 63);

async function main() {
  await cryptoWaitReady();
  const provider = new WsProvider(RPC);
  const keyring = new Keyring({type: "sr25519"});
  const api = await ApiPromise.create({
    provider,
    types,
    typesAlias
  });

  const [chain, nodeVersion] = await Promise.all([
    api.rpc.system.chain(),
    api.rpc.system.version(),
  ]);
  console.log(`connected to ${RPC} (${chain} ${nodeVersion})`);

  const from = keyring.addFromUri(ACCOUNT_SECRET);
  console.log("sudo account:", hdxAddress(from.addressRaw));

  const currentlyBondedAndUnlocking = async account => {
    const ledger = await api.query.staking.ledger(account);
    if (ledger.isSome) {
      const {active, unlocking} = ledger.unwrap();
      const totalUnlocking = unlocking.reduce((a, {value}) => value.toBn().add(a), new BN(0));
      return active.toBn().add(totalUnlocking);
    } else {
      return new BN(0);
    }
  }

  const stakingLock = '0x7374616b696e6720';

  const createStorageUpdate = async ({account, gen2: {totalUnlocking}}) => {
    const unlockingGen2 = hdxToBN(totalUnlocking);
    const [locks, currentlyLocked] = await Promise.all([
      api.query.balances.locks(account),
      currentlyBondedAndUnlocking(account)
    ]);
    const lock = locks.find(({id}) => stakingLock === id.toHex());
    const newAmount = lock.amount.sub(unlockingGen2);
    console.log(`${account} unlocks ${totalUnlocking} HDX`);
    assert(newAmount.eq(currentlyLocked), 'inconsistent locked value in ' + account);
    assert(!newAmount.isNeg(), 'negative locked balance');
    const updatedLock = api.registry.createType('BalanceLock', [
      stakingLock,
      api.registry.createType('Balance', newAmount),
      lock.reasons
    ]);
    const updatedLocks = locks.filter(({id}) => stakingLock !== id.toHex());
    if (!newAmount.isZero()) {
      updatedLocks.push(updatedLock);
    }
    return [
      api.query.balances.locks.key(account),
      api.registry.createType('Vec<BalanceLock>', updatedLocks).toHex()
    ];
  };

  const storageUpdates = await Promise.all(data.map(createStorageUpdate));

  const json = JSON.stringify(storageUpdates.reduce((j, [k, v]) => ({[k]: v, ...j}), {}), null, 2);
  console.log('storage updates generated');
  fs.writeFileSync('storageUpdates.json', json);

  const keyValues = api.registry.createType('Vec<KeyValue>', storageUpdates);

  const setStorage = api.tx.system.setStorage(keyValues);
  const sudo = api.tx.sudo.sudo(setStorage);

  if (process.argv[2] !== "send") {
    console.log('run "npm run send" to send tx');
    process.exit();
  }

  console.log("sending tx");
  await sudo.signAndSend(from, ({events = [], status}) => {
    if (status.isInBlock) {
      console.log("included in block");
    } else {
      console.log("tx: " + status.type);
    }
    if (status.type === "Finalized") {
      process.exit();
    }
    events
      .filter(({event: {section}}) =>
        ["system", "utility", "sudo"].includes(section)
      )
      .forEach(({event: {data, method, section}}) =>
        console.log(`event: ${section}.${method} ${data.toString()}`)
      );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit();
});
