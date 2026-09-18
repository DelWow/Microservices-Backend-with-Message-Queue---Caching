#!/bin/sh
set -eu

mongosh --host mongodb:27017 --quiet --eval '
try {
  rs.status();
} catch (error) {
  rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongodb:27017" }] });
}
'

until mongosh --host mongodb:27017 --quiet --eval 'quit(db.hello().isWritablePrimary ? 0 : 1)'; do
  sleep 1
done
