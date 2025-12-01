require('dotenv').config();
const Amadeus = require('amadeus');
const nodemailer = require('nodemailer');
const schedule = require('node-schedule');

// Configura Amadeus (usa Test por defecto)
const amadeus = new Amadeus({
  clientId: process.env.AMADEUS_CLIENT_ID,
  clientSecret: process.env.AMADEUS_CLIENT_SECRET
});

const PRECIO_MAX = parseFloat(process.env.PRECIO_MAXIMO);
const IDA_VUELTA = process.env.IDA_VUELTA === 'true';
const FECHA_INICIO = '2025-12-01';
const FECHA_FIN = '2025-12-21';

// Corre 3 veces al día: 8:00, 14:00 y 20:00 (hora local)
schedule.scheduleJob('0 8,14,20 * * *', buscarYNotificar);

console.log('🚀 Tracker Amadeus iniciado - buscará 3x/día vuelos MAD→BOG ≤', PRECIO_MAX, 'COP');

async function buscarYNotificar() {
  console.log(`\n🔍 Buscando ofertas ${new Date().toLocaleString('es-ES')}...`);

  try {
    // Paso 1: Encuentra las 3 fechas más baratas en el rango
    const fechasResponse = await amadeus.shopping.flightDates.get({
      originLocationCode: 'MAD',
      destinationLocationCode: 'BOG',
      departureDate: `${FECHA_INICIO} TO ${FECHA_FIN}`,
      adults: 1,
      currencyCode: 'COP',
      max: 3
    });

    const fechas = JSON.parse(fechasResponse.body).data[0].originDestinations[0].dates;
    console.log('Fechas más baratas:', fechas.map(f => `${f.date}: ${f.price.total}€`).join(', '));

    let ofertasValidas = [];

    // Paso 2: Para cada fecha top, busca ofertas detalladas y filtra
    for (const fechaObj of fechas) {
      if (parseFloat(fechaObj.price.total) > PRECIO_MAX) continue; // Salta si ya excede

      const fecha = fechaObj.date;
      console.log(`\n📅 Ofertas para ${fecha}...`);

      const searchParams = {
        originLocationCode: 'MAD',
        destinationLocationCode: 'BOG',
        departureDate: fecha,
        adults: 1,
        currencyCode: 'EUR',
        max: 10,  // Top 10 por fecha
        nonStop: 'false'  // Permite 1 escala
      };

      // Si ida/vuelta, ajusta (usa una fecha de regreso flexible)
      if (IDA_VUELTA) {
        searchParams.returnDate = '2026-01-15';  // Ejemplo fijo; ajusta si quieres dinámico
      }

      const ofertasResponse = await amadeus.shopping.flightOffersSearch.get(searchParams);
      const ofertas = JSON.parse(ofertasResponse.body).data;

      // Filtra por precio y escalas prohibidas
      for (const oferta of ofertas) {
        if (parseFloat(oferta.price.total) > PRECIO_MAX) continue;

        const itinerario = oferta.itinerary;
        const segmentos = itinerario.segments;
        let tieneEscalaProhibida = false;

        // Verifica escalas (aeropuertos intermedios)
        for (let i = 0; i < segmentos.length - 1; i++) {
          const aeropuertoEscala = segmentos[i].arrival.iataCode;
          if (aeropuertoEscala === 'BOG') continue;  // Ignora destino

          try {
            const aeropuertoResponse = await amadeus.referenceData.locations.getAirportByKey({
              key: aeropuertoEscala
            });
            const pais = JSON.parse(aeropuertoResponse.body).data.address.countryCode;

            if (pais === 'US' || pais === 'CA') {
              tieneEscalaProhibida = true;
              break;
            }
          } catch (err) {
            console.warn(`⚠️ No verificado ${aeropuertoEscala}: ${err.message}`);
          }
        }

        if (!tieneEscalaProhibida) {
          ofertasValidas.push({
            id: oferta.id,
            fecha: fecha,
            precio: parseFloat(oferta.price.total),
            aerolinea: segmentos[0].carrierCode,
            duracion: itinerario.duration,
            escalas: segmentos.length - 1,
            detalles: segmentos.map(s => `${s.carrierCode}${s.number} (${s.departure.at.slice(0,16)} → ${s.arrival.at.slice(0,16)})`)
          });
        }
      }
    }

    // Ordena y top 5
    ofertasValidas.sort((a, b) => a.precio - b.precio);
    const top5 = ofertasValidas.slice(0, 5);

    if (top5.length > 0) {
      console.log(`¡${top5.length} ofertas ≤ ${PRECIO_MAX}€! Enviando email...`);
      // await enviarEmail(top5);
    } else {
      console.log('No hay ofertas buenas hoy.');
    }

  } catch (err) {
    console.error('💥 Error Amadeus:', err.response?.data || err.message);
  }
}

// ====== EMAIL CON NODERMAILER ======
async function enviarEmail(ofertas) {
  let transporter = nodemailer.createTransporter({
    service: 'gmail',  // Cambia si usas Outlook/Yahoo
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_PASS
    }
  });

  let html = `
    <h2>¡OFERTAS VUELOS Madrid → Bogotá con Amadeus!</h2>
    <p>Encontradas ≤ <strong>${PRECIO_MAX} €</strong> (${IDA_VUELTA ? 'ida/vuelta' : 'solo ida'}) sin escalas en EE.UU./Canadá.</p>
    <table border="1" cellpadding="10" style="border-collapse:collapse; width:100%;">
      <tr style="background:#007bff; color:white;">
        <th>#</th><th>Precio</th><th>Fecha</th><th>Duración</th><th>Escalas</th><th>Aerolínea</th><th>Detalles</th>
      </tr>`;

  ofertas.forEach((o, i) => {
    const escalasText = o.escalas === 0 ? 'Directo ✈️' : `${o.escalas} escala${o.escalas > 1 ? 's' : ''}`;
    html += `
      <tr>
        <td>${i+1}</td>
        <td><strong>${o.precio} €</strong></td>
        <td>${o.fecha}</td>
        <td>${o.duracion}</td>
        <td>${escalasText}</td>
        <td>${o.aerolinea}</td>
        <td>${o.detalles.join(' | ')}</td>
      </tr>`;
  });

  html += `</table><br><small>Buscado el ${new Date().toLocaleString('es-ES')} vía Amadeus Test.</small>`;

  await transporter.sendMail({
    from: `"Vuelo Alert Amadeus" <${process.env.EMAIL_FROM}>`,
    to: process.env.EMAIL_TO,
    subject: `¡Vuelos MAD-BOG desde ${ofertas[0].precio}€! (${ofertas.length} ofertas)`,
    html: html
  });

  console.log('📧 Email enviado OK');
}

// Inicia una búsqueda manual al cargar (opcional)
buscarYNotificar();