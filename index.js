const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
require("dotenv").config();
const { ApiPromise } = require('@polkadot/api');
const { WsProvider } = require('@polkadot/rpc-provider');
const { xxhashAsHex } = require('@polkadot/util-crypto');
const { chain } = require('stream-chain');
const { parser } = require('stream-json');
const { streamArray } = require('stream-json/streamers/StreamArray');
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
const provider = new WsProvider(process.env.HTTP_RPC_ENDPOINT || 'http://localhost:9933')
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
const pageSize = process.env.PAGE_SIZE || 1000;
const BATCH_SIZE = 10000;
const NO_IGNORE_SIZE = 100000;

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
const peaqIgnorePrefixes = [
  '0x50b1bab256dbd966f3aa4c23d3a7a201', // PeaqDid
  '0xa94f76f4d854c6324f9c16806bea637a', // PeaqStorage
  '0x61c5c8e4cdb377abf7410e192c83b647', // PeaqRbac
  '0x1da53b775b270400e7e61ed5cbc5a146' // EVM
];

const skippedModulesPrefix = ['System', 'Babe', 'Grandpa', 'GrandpaFinality', 'FinalityTracker'];
const skippedParachainPrefix = ['ParachainSystem', 'ParachainInfo']
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

async function writeLargeJSONFile(filePath, object) {
    return new Promise((resolve, reject) => {
        const writableStream = fs.createWriteStream(filePath, { flags: "w" });

        // Write safely with backpressure handling
        async function writeDataSafely(data) {
            return new Promise((resolve) => {
                if (!writableStream.write(data)) {
                    writableStream.once("drain", resolve);
                } else {
                    resolve();
                }
            });
        }

        async function writeChunk(key, value, depth = 1, isFirstOfObject = false) {
            const indent = '  '.repeat(depth);
            if (!isFirstOfObject) await writeDataSafely(',\n');

            const chunk = `${indent}"${key}": `;

            if (Array.isArray(value)) {
                await writeDataSafely(chunk + JSON.stringify(value));
            } else if (typeof value === 'object' && value !== null) {
                const entries = Object.entries(value);
                if (entries.length === 0) {
                    await writeDataSafely(chunk + '{}');
                } else {
                    await writeDataSafely(chunk + '{\n');
                    let isFirstSubKey = true;
                    for (const [subKey, subValue] of entries) {
                        await writeChunk(subKey, subValue, depth + 1, isFirstSubKey);
                        isFirstSubKey = false;
                    }
                    await writeDataSafely(`\n${indent}}`);
                }
            } else {
                await writeDataSafely(chunk + JSON.stringify(value));
            }
        }

        let hasGenesis = false;
        let childrenDefault = {};

        (async () => {
            // ✅ Ensure the first `{` is written before starting
            await writeDataSafely('{\n');

            let isFirstKey = true;
            for (const [key, value] of Object.entries(object)) {
                if (key === "genesis" && value.raw && value.raw.top) {
                    hasGenesis = true;
                    if (value.raw.childrenDefault) {
                        childrenDefault = value.raw.childrenDefault;
                    }
                    continue;
                }
                await writeChunk(key, value, 1, isFirstKey);
                isFirstKey = false;
            }

            if (hasGenesis) {
                await writeDataSafely(',\n  "genesis": {\n');
                await writeDataSafely('    "raw": {\n');
                await writeDataSafely('      "top": {\n');

                let isFirstTopKey = true;
                const BATCH_SIZE = 500;
                const topEntries = Object.entries(object.genesis.raw.top);

                for (let i = 0; i < topEntries.length; i += BATCH_SIZE) {
                    const batch = topEntries.slice(i, i + BATCH_SIZE);

                    for (const [topKey, topValue] of batch) {
                        if (!isFirstTopKey) await writeDataSafely(',\n');
                        isFirstTopKey = false;
                        await writeDataSafely(`        "${topKey}": ${JSON.stringify(topValue)}`);
                    }
                }

                await writeDataSafely('\n      },\n');
                await writeDataSafely(`      "childrenDefault": ${JSON.stringify(childrenDefault, null, 6)}`);
                await writeDataSafely('\n    }\n');
                await writeDataSafely('  }');
            }

            // ✅ Ensure the last `}` is written
            await writeDataSafely('\n}\n');
            writableStream.end();
        })();

        writableStream.on("finish", () => {
            console.log("✅ JSON file writing completed!");
            resolve();
        });

        writableStream.on("error", (err) => {
            console.error("❌ Error writing JSON file:", err);
            reject(err);
        });
    });
}

function get_next_prefix(prefix) {
  let hexString = prefix.startsWith("0x")
      ? prefix.slice(2)
      : prefix;

  let incrementedHex = (BigInt("0x" + hexString) + BigInt(1)).toString(16);

  while (incrementedHex.length < hexString.length) {
      incrementedHex = "0" + incrementedHex;
  }

  let newKey = "0x" + incrementedHex;
  return newKey;
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
  console.log(chalk.green('We are intentionally using the WSS endpoint. If you see any warnings about that, please ignore them.'));
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
      console.log(chalk.yellow("Adding prefix for module: " + module.name.toHuman()));
      prefixes.push(xxhashAsHex(module.name, 128));
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
  .forEach(([key, value]) => {
    forkedSpec.genesis.raw.top[key] = value;
  });

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

  await writeLargeJSONFile(forkedSpecPath, forkedSpec);

  console.log(`Forked genesis generated successfully. Find it at ${forkedSpecPath}`);
  process.exit();
}

main();

async function fetchChunks(prefix, levelsRemaining, stream, at) {
  if (levelsRemaining <= 0) {
    let startKey = null;
    let no_skip_size = 0;
    while (true) {
      const keys = await provider.send('state_getKeysPaged', [prefix, pageSize, startKey, at]);
      if (keys.length > 0) {
        let pairs = [];
        await Promise.all(
          keys
            .map(async (key) => {
              const value = await provider.send('state_getStorage', [key, at]);
              pairs.push([key, value]);
            })
        );

        if (pairs.length > 0) {
          separator ? stream.write(",") : (separator = true);
          stream.write(JSON.stringify(pairs).slice(1, -1));
        }
        startKey = keys[keys.length - 1];
        let found_ignore_prefix_key = peaqIgnorePrefixes.some(prefix => startKey.startsWith(prefix));

        if (!found_ignore_prefix_key) {
          continue;
        }
        console.log(`Found ignore prefix key: ${found_ignore_prefix_key}`);
        let found_peaq_prefix_key = peaqIgnorePrefixes.find(prefix => startKey.startsWith(prefix));
        no_skip_size += keys.length;
        console.log(`Found peaq prefix key: ${found_peaq_prefix_key}, no skip size: ${no_skip_size}`);
        if (found_peaq_prefix_key && no_skip_size > NO_IGNORE_SIZE) {
          new_prefix = get_next_prefix(found_peaq_prefix_key);
          console.log(`New prefix: ${new_prefix}, old prefix: ${prefix}`);
          prefix = new_prefix;
          startKey = null;
          no_skip_size = 0;
        }
      }

      if (keys.length < pageSize) {
        break;
      }
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
