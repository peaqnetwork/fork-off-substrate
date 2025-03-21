#!/bin/sh

SOURCE_PATH=${SOURCE_PATH}
OUTPUT_PATH=${SOURCE_PATH}/output
RPC_ENDPOINT=${RPC_ENDPOINT:-"wss://wss-agung.peaq.network"}
ALICE=${ALICE:-"1"}
KEEP_COLLATOR=${KEEP_COLLATOR:-"false"}
IGNORE_WASM_UPDATE=${IGNORE_WASM_UPDATE:-"true"}
OVERRIDE_STORAGE_PATH=${OVERRIDE_STORAGE_PATH:-""}

# 0. Reset
rm -rf data || true
mkdir -p data
if [ ! -z "$OVERRIDE_STORAGE_PATH" ]; then
  ln -s $OVERRIDE_STORAGE_PATH data/storage.json
fi

# 1. Setup the same binary file we used in the current chain
if [ ! -f $SOURCE_PATH/peaq-node ]; then
  echo "Please put the peaq-node binary file in the source path: $SOURCE_PATH"
  exit 1
fi
ln -sf $SOURCE_PATH/peaq-node data/binary

# 2. Put the raw parachain file you can control here, for example: the sudo user, blah blah blah
./data/binary build-spec --disable-default-bootnode --chain $SOURCE_PATH/parachain.plaintext.config --raw > data/fork.json
./data/binary build-spec --disable-default-bootnode --chain $SOURCE_PATH/parachain.plaintext.config --raw > data/genesis.json

# 3. Run the binary to check the version
BINARY=data/binary
$BINARY --version

# 4. Update the subwasm
# Because we use the ignore wasm update, we don't need to use subwasm anymore
# subwasm --version
# subwasm get $RPC_ENDPOINT -o data/runtime.wasm
# subwasm info data/runtime.wasm

# 5. Fock the chain
HTTP_RPC_ENDPOINT=$RPC_ENDPOINT \
ALICE=$ALICE \
KEEP_COLLATOR=$KEEP_COLLATOR \
IGNORE_WASM_UPDATE=$IGNORE_WASM_UPDATE \
npm start

# 6. Store to output
mkdir -p $OUTPUT_PATH
cp data/fork.json $OUTPUT_PATH/fork.json
./data/binary export-genesis-wasm --chain data/fork.json > $OUTPUT_PATH/fork.json.wasm
./data/binary export-genesis-state --chain data/fork.json > $OUTPUT_PATH/fork.json.genesis
ls -ltra $OUTPUT_PATH/fork*
