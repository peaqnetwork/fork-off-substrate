#!/bin/sh

SOURCE_PATH=${SOURCE_PATH:-"/home/jaypan/Work/peaq/fork-test/fork-binary/peaq-dev-v06042023"}
OUTPUT_PATH=${SOURCE_PATH}/output
RPC_ENDPOINT=${RPC_ENDPOINT:-"https://rpcpc1-qa.agung.peaq.network"}
ALICE=${ALICE:-"1"}

# Setup
rm -rf data || true
mkdir -p data

# 1. Setup the same binary file we used in the current chain
if [ ! -f $SOURCE_PATH/peaq-node ]; then
  echo "Please put the peaq-node binary file in the source path: $SOURCE_PATH"
  exit 1
fi
ln -sf $SOURCE_PATH/peaq-node data/binary

# 2. Put the raw parachain file you can control here, for example: the sudo user, blah blah blah
./data/binary build-spec --disable-default-bootnode --chain $SOURCE_PATH/parachain.plaintext.config --raw > data/fork.json
./data/binary build-spec --disable-default-bootnode --chain $SOURCE_PATH/parachain.plaintext.config --raw > data/genesis.json

# Run
HTTP_RPC_ENDPOINT=$RPC_ENDPOINT \
ALICE=$ALICE \
scripts/docker-start.sh

# Output
mkdir -p $OUTPUT_PATH
cp data/fork.json $OUTPUT_PATH/fork.json
./data/binary export-genesis-wasm --chain data/fork.json > $OUTPUT_PATH/fork.json.wasm
./data/binary export-genesis-state --chain data/fork.json > $OUTPUT_PATH/fork.json.genesis
ls -ltra $OUTPUT_PATH/fork*
