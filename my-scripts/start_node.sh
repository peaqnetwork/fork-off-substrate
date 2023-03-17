./binary \
    --validator \
    --alice \
    --chain fork.json \
    --base-path ./chain-data-01 \
    --port 30333 \
    --ws-port 9944 \
    --rpc-port 9933 \
    --unsafe-rpc-external \
    --unsafe-ws-external \
    --rpc-cors=all \
    --rpc-methods=Unsafe