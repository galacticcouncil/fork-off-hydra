const BN = require("bn.js");
const fs = require("fs");
const {ApiPromise, WsProvider} = require("@polkadot/api");
const {cryptoWaitReady} = require("@polkadot/util-crypto");
const {types, typesAlias} = require("./types");

const RPC = process.env.RPC_SERVER || "ws://127.0.0.1:9944";

async function main() {
  await cryptoWaitReady();
  const provider = new WsProvider(RPC);
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

  const currentlyBondedAndUnlocking = ({active, unlocking}) => {
    const totalUnlocking = unlocking.reduce((a, {value}) => value.toBn().add(a), new BN(0));
    return active.toBn().add(totalUnlocking);
  };

  const ledger = await api.query.staking.ledger.entries();

  const inconsistencies = ledger.map(([{args: [account]}, data]) => {
    const ledger = data.unwrap();
    const currentlyLocked = currentlyBondedAndUnlocking(ledger);
    if (!ledger.total.toBn().eq(currentlyLocked)) {
      return [account, ledger];
    }
  }).filter(i => i);

  console.log(`found ${inconsistencies.length} inconsistencies`);


  const I = inconsistencies.map(([account]) => account.toHuman());
  const D = require('./data.json').map(({account}) => account);

  const diff = I.filter(i => !D.includes(i));

  if (diff.length === 0 && I.length === D.length) {
    console.log('inconsistencies are consistent with data.json');
  } else {
    console.log('inconsistencies are not consistsent');
    console.log(diff);
  }
  process.exit();
}

main().catch((e) => {
  console.error(e);
  process.exit();
});
