# Fork off substrate

This script allows bootstrapping a new substrate chain with the current state of a live chain. Using this, you can create a fork of Polkadot, Kusama and other substrate chain for development purposes.

## Usage

1. Clone this repository and install dependencies

    ```bash
    git clone https://github.com/maxsam4/fork-off-substrate.git
    cd fork-off-substrate
    npm i
    ```

2. Create a folder called `data` inside the top folder (`fork-off-substrate`).

    ```bash
    mkdir data
    ```

3. Copy the executable/binary of your substrate based node inside the data folder and rename it to `binary`.

4. Copy the runtime WASM blob of your substrate based blockchain to the data folder and rename it to `runtime.wasm`. To get the WASM blob, compile your blockchain and look for `./target/release/wbuild/runtime/runtime.compact.wasm`. If you are forking Polkadot/Kusama/Westend, you can download the WASM blobs from [Polkadot's release page](https://github.com/paritytech/polkadot/releases).

5. If your substrate chain uses additional custom types than what are available in polkadot.js, define them in a JSON file of format `{ "types": { <YOUR_TYPES> } }`. Copy the file to the `data` folder and rename it to `schema.json`.

6. Either run a full node for your blockchain locally(Recommended) or have an external endpoint handy.

7. Run the script
    * If using a local node, simply run the script using

        ```bash
        npm start
        ```

    * If you are using an external/non-default endpoint, you need to provide it to the script via the `HTTP_RPC_ENDPOINT` environment variable

        ```bash
        HTTP_RPC_ENDPOINT=https://example.com npm start
        ```

8. You should have the genesis file for the forked chain inside the `data` folder. It will be called `fork.json`.

9. You can now run a new chain using this genesis file

    ```bash
    ./binary --chain fork.json --alice
    ```

## Configuration

The script can be tweaked and configured using various environment variables -

| Environment Variable | Effects | Default value |
| --- | --- | --- |
| HTTP_RPC_ENDPOINT | HTTP RPC endpoint that should be used to query state | http://localhost:9933 |
| FORK_CHUNKS_LEVEL | Determines how many chunks to split the RPC download in. Effect is exponential, recommended value for most is 1. You can try 0 for small chains and 2 for large chains for potential speed improvements | 1 |
| ORIG_CHAIN | Chain to use as the original chain.  | `$default_of_the_binary` |
| FORK_CHAIN | Chain to use as base for the forked chain.  | `dev` |
| ALICE | If set, the script will replace the chain's sudo account with `//Alice` | `NULL` |
| QUICK_MODE | If set, it parallelizes the data download from the RPC endpoint | `NULL` |

## Read more

If you would like to understand how this script works, please read this [blog post](https://mudit.blog/fork-substrate-blockchain/)

## Using Docker

### Build the image

    docker build -t fork-off-substrate .

### Run

    BINARY=/full/path/to/your/linux/binary
    HTTP_RPC_ENDPOINT=http://localhost:9933
    docker run --rm -it \
        -e HTTP_RPC_ENDPOINT=$HTTP_RPC_ENDPOINT \
        -v "$BINARY":/data/binary
        fork-off-substrate

## Credits

This script is based on [a script shared in the substrate riot channel](https://hackmd.io/mGgNZX0VT4S0UTaq89-_SQ)

# Forked chain for runtime upgrade testings
For runtimeupgrade testings, we have to fork the source chain. Please use the forked.generated.sh to genrate the related files
1. Create one folder
2. Copy the peaq-node in the formal docker image to that folder
If your want to forked the parachain which ran the runtime upgraded already, please remember to use the correct binary
and docker image which are the same as the runtime upgrade.
For example, our Krest network's runtime ugprade version is based on the krest-v0.0.3, then your binary/docker image
should be also based on the krest-v0.0.3
3. Prepare the parachain.plaintext.config into your folder, too. In this steps, please use the chain spec file you can control. For example, the chain spec file which is genrated by the parachain launch.
4. Run the binary to genrate the file
```
env ALICE=1 \
SOURCE_PATH="/home/jaypan/Work/peaq/fork-test/fork-binary/peaq-dev-v06042023" \
RPC_ENDPOINT="https://rpcpc1-qa.agung.peaq.network" \
sh forked.generated.sh;

env ALICE=1 \
SOURCE_PATH="/home/jaypan/Work/peaq/fork-test/fork-binary/krest-v0.0.3" \
RPC_ENDPOINT="https://erpc-krest.peaq.network" \
sh -x forked.generated.sh;

```
5. The forked raw chain spec/genesis file/wasm file are genrated into your folder under your SOURCE_FOLDER
6. Please use that file to register your parachain
