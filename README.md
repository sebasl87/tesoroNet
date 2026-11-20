# Búsqueda del Tesoro QR (Netlify)

Deploy (desde esta carpeta):
    npm install
    npx netlify-cli link --id 3de00473-47ed-486e-84b4-58ec5e80811c
    npx netlify-cli deploy --prod

Variable requerida: ADMIN_PASSWORD (ya cargada en el sitio).
Admin: /admin · QRs para imprimir: /admin/print · Jugadores: escanean QR o entran a /
Datos guardados en Netlify Blobs. No edites pistas en el admin mientras los equipos están jugando.
