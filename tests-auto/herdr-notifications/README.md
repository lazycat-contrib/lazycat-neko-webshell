# Herdr notification replay regression

Run `npm run test:browser -- herdr-notifications`.

This isolated browser fixture uses the production event policy, refresh loop,
notification controller and message presenter. It injects retained working/done
statuses while the authoritative completion marker stays unchanged. Opening a
new tab, reconnecting and refreshing titles must remain silent; advancing the
completion marker and entering blocked must each emit one UI alert and one
system notification request. No live Herdr instance or system notification is
used by this fixture.
