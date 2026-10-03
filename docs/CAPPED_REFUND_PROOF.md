# Capped refund and historical receipt characterization

The existing refund calculation cannot credit energy beyond the wallet cap.
A Controller grant can fill some or all available room after a sync charges
but before its failed operation settles. The resulting receipt can therefore
contain a smaller refund or zero, even when no note succeeded.

Four disposable database scenarios exercise standard/instant operations with
zero/three energy of remaining room. They open an operation with the real
billing code, credit through the real admin route, concurrently settle the
failed operation, inspect wallet/ledger/results, then free energy room and
replay twice through the push route. The saved charge/refund must remain
historical: no new debit, extra refund or Drive write, and a standard window
must still be restored. The tests use only synthetic credentials/data in the
existing disposable replica-set suite.

This characterizes current behavior; it is not a reproduced production defect
or a new economy rule. No production implementation changes are included.
Typecheck, unit/build checks and disposable integration CI are required. The
App must use recorded receipt amounts rather than infer a complete refund or
new debit from a failed/replayed request. Actual wallet grants, real Drive,
network loss and physical-device display remain outside these fixtures.

Rollback removes only this test/document addition. No schema, indexes,
retention, dependencies, prices or production data change.
