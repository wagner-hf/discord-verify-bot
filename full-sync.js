// FULL SYNC (manual): para TODAS las filas con correo, revisa Teachable, DA los roles de Discord
// de las membresías activas que falten y reescribe el Source of Truth (Active/Inactive y Yes/No).
// Úsalo al agregar una estrategia nueva o para reactivar a quien renovó. No quita roles:
// eso lo hace el offboarding diario (index.js).
// DRY_RUN=true -> solo muestra lo que haría.
const s = require('./shared');

async function runFullSync() {
    console.log(`🚀 Iniciando Full Sync${s.DRY_RUN ? ' (DRY RUN: no se cambia nada)' : ''}...\n`);
    s.validateProducts();

    const rows = await s.readRows();
    if (rows.length === 0) return console.log('⚠️ No se encontraron datos en el Sheet.');

    const candidates = [];
    for (let i = 1; i < rows.length; i++) {
        const email = String(rows[i][0] || '').trim();
        if (email) candidates.push({ rowNumber: i + 1, row: rows[i], email, discordUserId: String(rows[i][1] || '').trim() });
    }
    console.log(`📄 ${candidates.length} filas con correo por revisar.\n`);

    const added = [];
    const notFound = [];
    let updated = 0, skipped = 0;

    for (let n = 0; n < candidates.length; n++) {
        const c = candidates[n];
        const tag = `🔍 [${n + 1}/${candidates.length}] Fila ${c.rowNumber} ${c.email}`;

        const t = await s.getTeachableUser(c.email);
        if (t.status !== 'ok') {
            if (t.status === 'not_found') notFound.push(c.email);
            console.log(`${tag} -> ⚠️ ${t.status === 'not_found' ? 'no existe en Teachable' : 'error de Teachable (' + t.message + ')'}, se salta`);
            skipped++;
            await s.sleep(1000);
            continue;
        }

        const has = s.activeFlags(t.courses);
        const newValues = s.rowValues(has);
        const changed = newValues.some((v, k) => v !== s.currentValues(c.row)[k]);

        // Discord: solo se dan los roles activos que la persona todavía no tiene.
        let discordNote = '';
        if (!c.discordUserId) {
            discordNote = ' | sin Discord ID';
        } else {
            let memberRoles = null;
            try {
                memberRoles = await s.getMemberRoles(c.discordUserId);
            } catch (e) {
                discordNote = ` | error leyendo Discord (${e.response?.status || e.message})`;
            }
            if (memberRoles === null && !discordNote) discordNote = ' | ya no está en Discord';
            if (memberRoles) {
                const missing = s.PRODUCTS.filter((p, k) => p.roleId && has[k] && !memberRoles.includes(p.roleId));
                for (const p of missing) {
                    if (!s.DRY_RUN) {
                        try {
                            await s.addRole(c.discordUserId, p.roleId);
                        } catch (e) {
                            console.error(`   ❌ No se pudo dar ${p.name} a ${c.email}:`, e.response?.data || e.message);
                            continue;
                        }
                        await s.sleep(300);
                    }
                    added.push({ Correo: c.email, Rol_Asignado: p.name });
                }
                if (missing.length) discordNote = ` | dar: ${missing.map((p) => p.key).join(', ')}`;
            }
        }

        if (changed && !s.DRY_RUN) {
            try {
                await s.updateRow(c.rowNumber, newValues);
            } catch (e) {
                console.error(`   ❌ No se pudo actualizar la fila ${c.rowNumber}:`, e.message);
            }
        }
        if (changed) updated++;

        console.log(`${tag} -> activos: ${s.keysOf(has)}${discordNote}${changed ? ` | Sheet: ${newValues.join(', ')}` : ' | Sheet sin cambios'}`);
        await s.sleep(1100); // límites de Teachable y de escrituras en Sheets
    }

    console.log(`\n🏁 Full Sync finalizado${s.DRY_RUN ? ' (DRY RUN)' : ''}.`);
    console.log(`📋 Revisados: ${candidates.length} | Saltados: ${skipped} | Roles ${s.DRY_RUN ? 'que se darían' : 'asignados'}: ${added.length} | Filas ${s.DRY_RUN ? 'que se actualizarían' : 'actualizadas'}: ${updated}`);
    if (added.length) console.table(added);
    if (notFound.length) console.log(`\n🔎 No encontrados en Teachable (revisar a mano): ${notFound.join(', ')}`);
}

runFullSync().catch((error) => {
    console.error('❌ Error crítico en el Full Sync:', error);
    process.exitCode = 1;
});
