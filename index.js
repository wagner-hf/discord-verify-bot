// OFFBOARDING DIARIO: quita los roles de Discord de las membresías que ya no están activas en
// Teachable y actualiza el Source of Truth. Lo ejecuta Heroku Scheduler a las 3:00 AM UTC.
// DRY_RUN=true      -> solo muestra lo que haría.
// MAX_REMOVALS=200  -> si una corrida planea quitar más roles que esto, no aplica nada.
const s = require('./shared');

const MAX_REMOVALS = Number(process.env.MAX_REMOVALS || 200);

async function runOffboardingWorker() {
    console.log(`🚀 Iniciando Offboarding${s.DRY_RUN ? ' (DRY RUN: no se cambia nada)' : ''}...\n`);
    s.validateProducts();

    const rows = await s.readRows();
    if (rows.length === 0) return console.log('⚠️ No se encontraron datos en el Sheet.');

    // Solo se revisan las filas Active con correo y Discord ID.
    const candidates = [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const email = String(row[0] || '').trim();
        const discordUserId = String(row[1] || '').trim();
        if (String(row[3] || '').trim() === 'Active' && email && discordUserId) {
            candidates.push({ rowNumber: i + 1, row, email, discordUserId });
        }
    }
    console.log(`📄 ${candidates.length} filas activas por revisar (unos 2 segundos cada una).\n`);

    // Paso 1: calcular el plan sin tocar nada.
    const plan = [];
    const notFound = [];
    let skipped = 0;
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
        const memberRoles = await s.getMemberRoles(c.discordUserId);
        // Solo se quitan roles que la persona TIENE y cuyo producto ya no está activo.
        const removals = memberRoles === null
            ? []
            : s.PRODUCTS.filter((p, k) => p.roleId && !has[k] && memberRoles.includes(p.roleId));
        const newValues = s.rowValues(has);
        const changed = newValues.some((v, k) => v !== s.currentValues(c.row)[k]);

        console.log(`${tag} -> activos: ${s.keysOf(has)}` +
            (memberRoles === null ? ' | ya no está en Discord' : '') +
            (removals.length ? ` | quitar: ${removals.map((p) => p.key).join(', ')}` : '') +
            (changed ? ` | Sheet: ${newValues[0]}` : ' | sin cambios'));

        plan.push({ ...c, removals, newValues, changed });
        await s.sleep(1000);
    }

    const totalRemovals = plan.reduce((x, p) => x + p.removals.length, 0);
    const totalUpdates = plan.filter((p) => p.changed).length;
    console.log(`\n📋 Revisados: ${candidates.length} | Saltados: ${skipped} | Roles a quitar: ${totalRemovals} | Filas a actualizar: ${totalUpdates}`);

    if (totalRemovals > MAX_REMOVALS) {
        console.error(`🛑 Se planean ${totalRemovals} remociones (límite ${MAX_REMOVALS}). No se aplica nada: revisa los nombres de los cursos y la API de Teachable antes de subir MAX_REMOVALS.`);
        process.exitCode = 1;
        return;
    }

    // Paso 2: aplicar.
    if (totalRemovals + totalUpdates > 0) console.log(`\n✍️ ${s.DRY_RUN ? 'Cambios que se aplicarían' : 'Aplicando cambios'}...`);
    const summary = [];
    for (const p of plan) {
        for (const prod of p.removals) {
            if (!s.DRY_RUN) {
                try {
                    await s.removeRole(p.discordUserId, prod.roleId);
                } catch (e) {
                    console.error(`   ❌ No se pudo quitar ${prod.name} a ${p.email}:`, e.response?.data || e.message);
                    continue;
                }
                await s.sleep(300);
            }
            console.log(`   ➖ ${p.email}: ${prod.name}`);
            summary.push({ Correo: p.email, Rol_Removido: prod.name });
        }
        if (p.changed) {
            if (!s.DRY_RUN) {
                try {
                    await s.updateRow(p.rowNumber, p.newValues);
                } catch (e) {
                    console.error(`   ❌ No se pudo actualizar la fila ${p.rowNumber}:`, e.message);
                    continue;
                }
                await s.sleep(1100); // límite de escrituras de la API de Sheets
            }
            console.log(`   📝 Fila ${p.rowNumber} (${p.email}) -> ${p.newValues.join(', ')}`);
        }
    }

    console.log(`\n🏁 Offboarding finalizado${s.DRY_RUN ? ' (DRY RUN)' : ''}.`);
    if (summary.length) {
        console.log(`\n📊 ROLES ${s.DRY_RUN ? 'QUE SE QUITARÍAN' : 'REMOVIDOS'}:`);
        console.table(summary);
    } else {
        console.log('\n📊 No hubo roles que quitar.');
    }
    if (notFound.length) {
        console.log(`\n🔎 No encontrados en Teachable (conservan sus roles; revisar a mano): ${notFound.join(', ')}`);
    }
}

runOffboardingWorker().catch((error) => {
    console.error('❌ Error crítico en el script:', error);
    process.exitCode = 1;
});
