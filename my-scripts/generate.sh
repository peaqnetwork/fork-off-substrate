#!/bin/sh

./binary export-genesis-wasm --chain fork.json > ~/PublicSMB/peaq.qa.test/fork.json.wasm
./binary export-genesis-state --chain fork.json > ~/PublicSMB/peaq.qa.test/fork.json.genesis

ls -ltra ~/PublicSMB/fork*
