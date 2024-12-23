const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
require("dotenv").config();
const { ApiPromise } = require('@polkadot/api');
const { HttpProvider } = require('@polkadot/rpc-provider');
const { xxhashAsHex } = require('@polkadot/util-crypto');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/StreamArray');
const stringify = require('streaming-json-stringify'); // Correct streaming JSON library
const execFileSync = require('child_process').execFileSync;
const execSync = require('child_process').execSync;
const binaryPath = path.join(__dirname, 'data', 'binary');
const wasmPath = path.join(__dirname, 'data', 'runtime.wasm');
const schemaPath = path.join(__dirname, 'data', 'schema.json');
const hexPath = path.join(__dirname, 'data', 'runtime.hex');
const originalSpecPath = path.join(__dirname, 'data', 'genesis.json');
const forkedSpecPath = path.join(__dirname, 'data', 'fork.json');
const storagePath = path.join(__dirname, 'data', 'storage.json');

// Using http endpoint since substrate's Ws endpoint has a size limit.
const provider = new HttpProvider(process.env.HTTP_RPC_ENDPOINT || 'http://localhost:9933')
// The storage download will be split into 256^chunksLevel chunks.
const chunksLevel = process.env.FORK_CHUNKS_LEVEL || 1;
const totalChunks = Math.pow(256, chunksLevel);

const alice = process.env.ALICE || ''
const originalChain = process.env.ORIG_CHAIN || '';
const forkChain = process.env.FORK_CHAIN || '';
const keepCollator = process.env.KEEP_COLLATOR === 'true';
const keepAsset = process.env.KEEP_ASSET === 'true';
const keepParachain = process.env.KEEP_PARACHAIN === 'true';
const ignoreWASMUpdate = process.env.IGNORE_WASM_UPDATE === 'true';

let chunksFetched = 0;
let separator = false;
const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

/**
 * All module prefixes except those mentioned in the skippedModulesPrefix will be added to this by the script.
 * If you want to add any past module or part of a skipped module, add the prefix here manually.
 *
 * Any storage value’s hex can be logged via console.log(api.query.<module>.<call>.key([...opt params])),
 * e.g. console.log(api.query.timestamp.now.key()).
 *
 * If you want a map/doublemap key prefix, you can do it via .keyPrefix(),
 * e.g. console.log(api.query.system.account.keyPrefix()).
 *
 * For module hashing, do it via xxhashAsHex,
 * e.g. console.log(xxhashAsHex('System', 128)).
 */
let prefixes = ['0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9' /* System.Account */];
let peaqPrefixes = [];
const skippedModulesPrefix = ['System', 'Babe', 'Grandpa', 'GrandpaFinality', 'FinalityTracker'];
const skippedParachainPrefix = ['ParachainSystem', 'ParachainInfo']
const isPeaqPrefix = ['PeaqDid', 'PeaqStorage', 'PeaqRbac']
const skippedCollatorModulesPrefix = ['Authorship', 'Aura', 'AuraExt', 'ParachainStaking', 'Session'];
const skippedAssetPrefix = ['Assets', 'XcAssetConfig', 'EVM', 'Ethereum'];

async function fixParachinStates (api, forkedSpec) {
  const skippedKeys = [
  // The parachain didn't have the parasScheduler module, so we skip below module
  // parasScheduler module only on relay chain, but we are forked parachain
  // api.query.parasScheduler.sessionStartBlock.key()
  ];
  for (const k of skippedKeys) {
    delete forkedSpec.genesis.raw.top[k];
  }
}

async function processLargeJSONFile(filePath) {
  const results = [];

  return new Promise((resolve, reject) => {
    const pipeline = chain([
      fs.createReadStream(filePath),
      parser(),
      streamArray(),
    ]);

    pipeline.on('data', ({ value }) => {
      results.push(value);
    });

    pipeline.on('end', () => {
      console.log('File processing completed');
      resolve(results);
    });

    pipeline.on('error', (err) => {
      console.error('Error processing file:', err);
      reject(err);
    });
  });
}

async function writeLargeJSONFile(filePath, data) {
  return new Promise((resolve, reject) => {
    const jsonStream = stringify(data, null, 4);
    const writeStream = fs.createWriteStream(filePath);
    jsonStream.pipe(writeStream);

    // Handle stream events
    writeStream.on('finish', () => {
      console.log('File writing completed');
      resolve();
    });

    writeStream.on('error', (err) => {
      console.error('Error writing file:', err);
      reject(err);
    });

    jsonStream.on('error', (err) => {
      console.error('Error during JSON serialization:', err);
      reject(err);
    });
  });
}

async function main() {
  if (!fs.existsSync(binaryPath)) {
    console.log(chalk.red('Binary missing. Please copy the binary of your substrate node to the data folder and rename the binary to "binary"'));
    process.exit(1);
  }
  execFileSync('chmod', ['+x', binaryPath]);

  if (!ignoreWASMUpdate) {
    if (!fs.existsSync(wasmPath)) {
      console.log(chalk.red('WASM missing. Please copy the WASM blob of your substrate node to the data folder and rename it to "runtime.wasm"'));
      process.exit(1);
    }
    execSync('cat ' + wasmPath + ' | hexdump -ve \'/1 "%02x"\' > ' + hexPath);
  }

  let api;
  console.log(chalk.green('We are intentionally using the HTTP endpoint. If you see any warnings about that, please ignore them.'));
  if (!fs.existsSync(schemaPath)) {
    console.log(chalk.yellow('Custom Schema missing, using default schema.'));

    api = await ApiPromise.create({ provider });
  } else {
    const { types, rpc } = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    api = await ApiPromise.create({
      provider,
      types,
      rpc,
    });
  }

  if (fs.existsSync(storagePath)) {
    console.log(chalk.yellow('Reusing cached storage. Delete ./data/storage.json and rerun the script if you want to fetch latest storage'));
  } else {
    // Download state of original chain
    console.log(chalk.green('Fetching current state of the live chain. Please wait, it can take a while depending on the size of your chain.'));
    let at = (await api.rpc.chain.getBlockHash()).toString();
    progressBar.start(totalChunks, 0);
    const stream = fs.createWriteStream(storagePath, { flags: 'a' });
    stream.write("[");
    await fetchChunks("0x", chunksLevel, stream, at);
    stream.write("]");
    stream.end();
    progressBar.stop();
  }

  const metadata = await api.rpc.state.getMetadata();
  // Populate the prefixes array
  const modules = metadata.asLatest.pallets;
  modules.forEach((module) => {
    if (module.storage) {
      if (skippedModulesPrefix.includes(module.name.toHuman())) {
        console.log(chalk.yellow("Skipping prefix for module: " + module.name.toHuman()));
        return;
      }
      if (!keepCollator && skippedCollatorModulesPrefix.includes(module.name.toHuman())) {
        console.log(chalk.yellow("Skipping collator prefix for module: " + module.name.toHuman()));
        return;
      }
      if (!keepAsset && skippedAssetPrefix.includes(module.name.toHuman())) {
        console.log(chalk.yellow("Skipping asset prefix for module: " + module.name.toHuman()));
        return;
      }
      if (!keepParachain && skippedParachainPrefix.includes(module.name.toHuman())) {
        console.log(chalk.yellow("Skipping parachain prefix for module: " + module.name.toHuman()));
        return;
      }
      if (isPeaqPrefix.includes(module.name.toHuman())) {
        console.log(chalk.yellow("Skipping prefix for peaq module: " + module.name.toHuman()));
        return;
      }
      console.log(chalk.yellow("Adding prefix for module: " + module.name.toHuman()));
      prefixes.push(xxhashAsHex(module.name, 128));
    }
  });
  modules.forEach((module) => {
    if (module.storage) {
      if (!isPeaqPrefix.includes(module.name.toHuman())) {
        console.log(chalk.yellow("Skipping prefix for not peaq module: " + module.name.toHuman()));
        return;
      }
      console.log(chalk.yellow("Adding prefix for module: " + module.name.toHuman()));
      peaqPrefixes.push(xxhashAsHex(module.name, 128));
    }
  });

  // Ignore this part, because we generate our own chain spec before.
  // // Generate chain spec for original and forked chains
  // if (originalChain == '') {
  //   execSync(binaryPath + ` build-spec --raw > ` + originalSpecPath);
  // } else {
  //   execSync(binaryPath + ` build-spec --chain ${originalChain} --raw > ` + originalSpecPath);
  // }
  // if (forkChain == '') {
  //   execSync(binaryPath + ` build-spec --dev --raw > ` + forkedSpecPath);
  // } else {
  //   execSync(binaryPath + ` build-spec --chain ${forkChain} --raw > ` + forkedSpecPath);
  // }

  let storage = await processLargeJSONFile(storagePath);
  let originalSpec = JSON.parse(fs.readFileSync(originalSpecPath, 'utf8'));
  let forkedSpec = JSON.parse(fs.readFileSync(forkedSpecPath, 'utf8'));

  // Modify chain name and id
  forkedSpec.name = originalSpec.name + '-fork';
  forkedSpec.id = originalSpec.id + '-fork';
  forkedSpec.protocolId = originalSpec.protocolId;

  // Grab the items to be moved, then iterate through and insert into storage
  storage
    .filter((i) => prefixes.some((prefix) => i[0].startsWith(prefix)))
    .forEach(([key, value]) => (forkedSpec.genesis.raw.top[key] = value));

  for (peaqPrefix of peaqPrefixes) {
    let count = 0;
    storage
      .filter((i) => i[0].startsWith(peaqPrefix))
      .some(([key, value]) => {
        forkedSpec.genesis.raw.top[key] = value;
        count++;
        if (count > 50000) {
          return true;
        }
        return false;
      });
      console.log(chalk.yellow(`Added ${count} items for prefix ${peaqPrefix}`));
  }

  // Delete System.LastRuntimeUpgrade to ensure that the on_runtime_upgrade event is triggered
  delete forkedSpec.genesis.raw.top['0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8'];

  fixParachinStates(api, forkedSpec);

  // Ignore the WASM update because the binary's WASM code is not the same as the runtime.wasm
  // However, if you want to update the WASM code, set the IGNORE_WASM_UPDATE env variable to false
  if (!ignoreWASMUpdate) {
    console.log(chalk.green('Updating WASM code'));
    // Set the code to the current runtime code
    forkedSpec.genesis.raw.top['0x3a636f6465'] = '0x' + fs.readFileSync(hexPath, 'utf8').trim();
  } else {
    console.log(chalk.yellow('Ignoring WASM update in stat. If you want to update the WASM code, set the IGNORE_WASM_UPDATE env variable to false'));
  }

  // To prevent the validator set from changing mid-test, set Staking.ForceEra to ForceNone ('0x02')
  forkedSpec.genesis.raw.top['0x5f3e4907f716ac89b6347d15ececedcaf7dad0317324aecae8744b87fc95f2f3'] = '0x02';

  // Reset parachainSystem.lastRelayChainBlockNumber to 0
  // otherwise we get the error: "Relay chain block number needs to strictly increase between Parachain blocks"
  // as we are using `type CheckAssociatedRelayNumber = RelayNumberStrictlyIncreases;`
  forkedSpec.genesis.raw.top['0x45323df7cc47150b3930e2666b0aa313a2bca190d36bd834cc73a38fc213ecbd'] = '0x00000000';

  if (alice !== '') {
    // Set sudo key to //Alice
    forkedSpec.genesis.raw.top['0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b'] = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
  }

  fs.writeFileSync(forkedSpecPath, JSON.stringify(forkedSpec, null, 4));
  // await writeLargeJSONFile(forkedSpecPath, forkedSpec);

  console.log('Forked genesis generated successfully. Find it at ./data/fork.json');
  process.exit();
}

main();

async function fetchChunks(prefix, levelsRemaining, stream, at) {
  if (levelsRemaining <= 0) {
    const pairs = await provider.send('state_getPairs', [prefix, at]);
    if (pairs.length > 0) {
      separator ? stream.write(",") : separator = true;
      stream.write(JSON.stringify(pairs).slice(1, -1));
    }
    progressBar.update(++chunksFetched);
    return;
  }

  // Async fetch the last level
  if (process.env.QUICK_MODE && levelsRemaining == 1) {
    let promises = [];
    for (let i = 0; i < 256; i++) {
      promises.push(fetchChunks(prefix + i.toString(16).padStart(2, "0"), levelsRemaining - 1, stream, at));
    }
    await Promise.all(promises);
  } else {
    for (let i = 0; i < 256; i++) {
      await fetchChunks(prefix + i.toString(16).padStart(2, "0"), levelsRemaining - 1, stream, at);
    }
  }
}
