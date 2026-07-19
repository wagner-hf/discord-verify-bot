require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');

// ==========================================
// CONFIGURACIÓN Y CONSTANTES
// ==========================================
const {
    SPREADSHEET_ID,
    TEACHABLE_API_KEY,
    DISCORD_TOKEN,
    DISCORD_GUILD_ID
} = process.env;

const ROLE_AAA = '1518678337839431971'; // Asymmetric Alpha Alerts
const ROLE_BRA = '1518679378916278432'; // Breakout Resource Alerts

// Inicializar cliente de Google Sheets con el archivo JSON
const auth = new google.auth.GoogleAuth({
    keyFile: './offboarding-service-502720-0a8eec578417.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// ==========================================
// FUNCIONES AUXILIARES (APIs)
// ==========================================

async function getTeachableUser(email) {
    try {
        const searchResponse = await axios.get(`https://developers.teachable.com/v1/users`, {
            headers: { 'Accept': 'application/json', 'apikey': TEACHABLE_API_KEY },
            params: { email: email }
        });
        
        const users = searchResponse.data.users || [];
        if (users.length === 0) return null;
        
        const studentId = users[0].id;
        const userDetails = await axios.get(`https://developers.teachable.com/v1/users/${studentId}`, {
            headers: { 'Accept': 'application/json', 'apikey': TEACHABLE_API_KEY }
        });
        
        return userDetails.data;
    } catch (error) {
        console.error(`❌ Error buscando en Teachable el email ${email}:`, error.message);
        return null;
    }
}

async function removeDiscordRole(discordUserId, roleId, roleName) {
    try {
        await axios.delete(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`, {
            headers: { 'Authorization': `Bot ${DISCORD_TOKEN}` }
        });
        console.log(`✅ Rol [${roleName}] removido en Discord para el usuario ${discordUserId}`);
    } catch (error) {
        console.error(`❌ Error removiendo rol [${roleName}] al usuario ${discordUserId}:`, error.response?.data || error.message);
    }
}

async function updateSheetStatus(rowNumber) {
    try {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Source of Truth!D${rowNumber}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [['Inactive']] }
        });
        console.log(`✅ Fila ${rowNumber} actualizada a 'Inactive' en Sheets.`);
    } catch (error) {
        console.error(`❌ Error actualizando Sheets en fila ${rowNumber}:`, error.message);
    }
}

// ==========================================
// FUNCIÓN PRINCIPAL (WORKER)
// ==========================================
async function runOffboardingWorker() {
    console.log('🚀 Iniciando script de Offboarding...\n');

    // Aquí guardaremos el reporte de los usuarios modificados
    const removedRolesSummary = [];

    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Source of Truth!A:D',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('⚠️ No se encontraron datos en el Sheet.');
            return;
        }

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const email = row[0];            
            const discordUserId = row[1];    
            const status = row[3];           

            if (status === 'Active' && email && discordUserId) {
                console.log(`🔍 Evaluando usuario: ${email}`);
                
                const teachableData = await getTeachableUser(email);
                
                if (!teachableData) {
                    console.log(`⚠️ Usuario ${email} no encontrado en Teachable. Saltando...\n`);
                    continue;
                }

                const courses = teachableData.courses || [];
                
                const activeCourses = courses
                    .filter(course => course.is_active_enrollment === true)
                    .map(course => course.course_name.toLowerCase());

                const hasAAA = activeCourses.some(name => name.includes('asymmetric alpha'));
                const hasBRA = activeCourses.some(name => name.includes('breakout resource'));

                let statusChanged = false;

                // Path A
                if (!hasAAA) {
                    await removeDiscordRole(discordUserId, ROLE_AAA, 'Asymmetric Alpha Alerts');
                    removedRolesSummary.push({ Correo: email, Rol_Removido: 'Asymmetric Alpha Alerts' });
                    statusChanged = true;
                }

                // Path B
                if (!hasBRA) {
                    await removeDiscordRole(discordUserId, ROLE_BRA, 'Breakout Resource Alerts');
                    removedRolesSummary.push({ Correo: email, Rol_Removido: 'Breakout Resource Alerts' });
                    statusChanged = true;
                }

                if (statusChanged && !hasAAA && !hasBRA) {
                    const excelRowNumber = i + 1; 
                    await updateSheetStatus(excelRowNumber);
                }
                
                console.log('---'); // Separador visual en consola
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        // ==========================================
        // REPORTE FINAL
        // ==========================================
        console.log('\n🏁 Script de Offboarding finalizado.');
        
        if (removedRolesSummary.length > 0) {
            console.log('\n📊 RESUMEN DE ROLES REMOVIDOS EN ESTA SESIÓN:');
            console.table(removedRolesSummary);
        } else {
            console.log('\n📊 RESUMEN: Todos los usuarios evaluados mantienen sus suscripciones activas. No se removieron roles.');
        }

    } catch (error) {
        console.error('❌ Error crítico en el script:', error);
    }
}

// Ejecutar el script
runOffboardingWorker();