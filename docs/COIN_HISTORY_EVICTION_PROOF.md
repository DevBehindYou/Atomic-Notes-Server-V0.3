# Coin history eviction proof

This test-only change invokes the inactive history cleanup helper in a uniquely named disposable database. No production policy, activation, migration or cleanup change.

A pre-activation account retains five non-expiring opening coins. A new Controller credit creates a 50-coin batch with its original six-month expiration; conversion consumes one coin from the expiring batch. Eviction removes all original full-history entries while leaving lots and operation receipts byte-for-byte unchanged.

Concurrent retries of the same credit and conversion must leave wallet, lots and receipts unchanged. Reusing an ID with another amount must fail. At the exact expiration time, two concurrent evaluations expire the remaining 49 coins once, preserving five grandfathered coins and energy. After the expiry event itself is removed from history, two further evaluations must neither remove another coin nor recreate that expiry event. The batch expiration date stays unchanged.

This proves retention independence for the specified coin paths in disposable CI. It does not enable six-month policy in production or prove production-scale migration, storage savings or app upgrade behavior.
