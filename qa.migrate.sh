rm data/fork.json
rm data/genesis.json
rm data/runtime.hex
rm data/storage.json

# 1. Put the QA's genesis.json file in the data/genesis.json
cp ~/PublicSMB/peaq.qa.env.production/parachain.raw.1.config data/genesis.json
# 2. Put the QA's fork.json file in the data/fork.json
cp ~/PublicSMB/peaq.qa.env.production/parachain.raw.1.config data/fork.json
# 3. Put the QA's runtime module
# cp ~/PublicSMB/peaq.qa.env.production/parachain.1.wasm data/runtime.wasm

HTTP_RPC_ENDPOINT=http://rpcpc1-qa.agung.peaq.network:9933 scripts/docker-start.sh

(cd data; sh -x ../my-scripts/generate.sh)

# (cd parachain; sh -x my-scripts/start_node.sh)
