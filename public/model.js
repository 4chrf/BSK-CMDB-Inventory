(function (root) {
  const fieldKeys = ['server','application','component','status','criticality','ha','secondary','group','owner','installed','asset','location','rack','rackUnit','cluster','bay'];
  const absent = v => !v || ['na','n/a','n.a','-','none'].includes(String(v).trim().toLowerCase());
  const appKey = v => String(v || '').trim().toLowerCase();
  function migrate(input) {
    const data = structuredClone(input);
    data.schemaVersion = 2;
    data.applications ||= [];
    const catalog = new Map(data.applications.map(a => [appKey(a.name), a]));
    for (const host of data.hosts) {
      if (!host.type) {
        host.type = host.placements.length ? 'physical' : host.records.some(r => /vmware/i.test(r.ha)) ? 'virtual' : 'unclassified';
        host.typeBasis = host.type === 'physical' ? 'Inferred from a documented rack placement; verify.' : host.type === 'virtual' ? 'Inferred from VMware HA in the CMDB; verify.' : 'Not determined from the source. Choose physical or virtual.';
      }
      host.vmware ||= { vcenter:'', cluster:host.type === 'virtual' ? host.records.map(r=>r.cluster).find(v=>!absent(v)) || '' : '', esxiHost:'', vmName:host.type === 'virtual' ? host.server : '' };
      for (const record of host.records) {
        if (!absent(record.application)) {
          let app = catalog.get(appKey(record.application));
          if (!app) {
            app = { id:'app-'+String(data.applications.length + 1).padStart(4,'0'), name:record.application.trim(), owner:'', description:'Imported from CMDB application names.', source:'CMDB import' };
            while (data.applications.some(a=>a.id===app.id)) app.id += '-new';
            catalog.set(appKey(app.name), app);
            data.applications.push(app);
          }
          record.applicationId = app.id;
        } else record.applicationId = '';
      }
    }
    return data;
  }
  function validate(data) {
    const fail = message => { throw new Error(message); };
    const idOK = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);
    const textOK = (s, max=3000) => typeof s === 'string' && s.length <= max;
    if (!data || data.schemaVersion !== 2 || !Array.isArray(data.hosts) || !Array.isArray(data.racks) || !Array.isArray(data.applications) || !Array.isArray(data.audit) || !Array.isArray(data.sources) || !Array.isArray(data.notes)) fail('Invalid workspace structure.');
    if (data.hosts.length > 20000 || data.racks.length > 1000 || data.applications.length > 5000 || data.audit.length > 10000) fail('Workspace limit exceeded.');
    for (const items of [data.hosts, data.racks, data.applications]) if (new Set(items.map(x=>x.id)).size !== items.length || items.some(x=>!idOK(x.id))) fail('Invalid or duplicate identifiers.');
    if (new Set(data.applications.map(a=>appKey(a.name))).size !== data.applications.length) fail('Application names must be unique.');
    const appIds = new Set(data.applications.map(a=>a.id));
    const racks = new Map(data.racks.map(r=>[r.id,r]));
    for (const app of data.applications) if (!textOK(app.name,1500) || !app.name.trim() || !textOK(app.owner||'') || !textOK(app.description||'')) fail('Invalid application fields.');
    for (const rack of data.racks) if (!textOK(rack.name) || !rack.name.trim() || !textOK(rack.room) || !rack.room.trim() || !textOK(rack.aisle) || !Number.isInteger(rack.units) || rack.units<1 || rack.units>60) fail('Invalid rack fields.');
    for (const host of data.hosts) {
      if (!textOK(host.server,1500) || !host.server.trim() || !['physical','virtual','unclassified'].includes(host.type) || !Array.isArray(host.records) || !Array.isArray(host.placements) || !Array.isArray(host.connections)) fail('Invalid host fields.');
      if (host.type !== 'physical' && host.placements.length) fail('Only physical hosts can have rack placements.');
      if (!host.vmware || ['vcenter','cluster','esxiHost','vmName'].some(k=>!textOK(host.vmware[k]||''))) fail('Invalid VMware fields.');
      for (const record of host.records) {
        if (fieldKeys.some(k=>!textOK(record[k],1500))) fail('Invalid CMDB record.');
        if (record.applicationId && !appIds.has(record.applicationId)) fail('An application is still referenced by a host. Remove its host assignments before deleting it.');
        if (!record.applicationId && !absent(record.application)) fail('Choose an application from the catalog.');
      }
      for (const p of host.placements) {
        const rack = racks.get(p.rackId);
        if (!rack || !Number.isInteger(p.unit) || !Number.isInteger(p.height) || p.unit<1 || p.height<1 || p.unit+p.height-1>rack.units) fail('Invalid or orphaned rack placement.');
      }
    }
    return true;
  }
  // Imported placements may overlap. Preserve them until reviewed, but reject
  // any newly created or moved placement that would claim occupied rack units.
  function validatePlacementChanges(previous, next) {
    const before = new Map(previous.hosts.map(host => [host.id, host.placements]));
    for (const host of next.hosts) for (const [index, placement] of host.placements.entries()) {
      const unchanged = (before.get(host.id) || []).some(old =>
        old.rackId === placement.rackId && old.unit === placement.unit && old.height === placement.height);
      if (unchanged) continue;
      const end = placement.unit + placement.height;
      const overlap = next.hosts.some(other => other.placements.some((existing, otherIndex) =>
        existing.rackId === placement.rackId &&
        (other.id !== host.id || otherIndex !== index) &&
        placement.unit < existing.unit + existing.height && existing.unit < end));
      if (overlap) throw new Error('These rack units already contain a documented device. Choose another position.');
    }
  }
  root.CmdbModel = { fieldKeys, migrate, validate, validatePlacementChanges, absent, appKey };
})(globalThis);
