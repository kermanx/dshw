/**
 * dshw kanban plugin — node half.
 *
 * Deliberately empty: the dashboard is served by the local dshw daemon and
 * embedded by the browser half (this package's ./client bundle). The harness
 * loader still needs a loadable plugin module here so the bundle patch row
 * (`cordis.patch.yml`, name 'dshw') can resolve — there is no host-side
 * capability to contribute.
 */

exports.name = 'dshw-kanban'

/** Mount the (empty) host half. */
exports.apply = () => {}
