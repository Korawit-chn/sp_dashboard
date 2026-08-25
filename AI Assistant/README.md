# Dashboard
## Step 0
```
node -v
npm -v
mysql --version
```

## Step 1
Check Folder:
```
dashboard/
├─ backend/
|       ├─ .env
|       └─ server.js
├─ frontend/
|       ├─ html/
|       |    ├─ index.html
|       |    └─ wind.html
|       ├─ js/
|       |    ├─ config.js
|       |    ├─ script.js
|       |    └─ wind.js
|       └─ style.css
└─ database.sql
```

## Step 1.5
Create User and run Database
```
Get user info from .env file in <backend/.env>
Don't forget about Schema Privileges
```

### Existing database — run the migration instead

`database.sql` starts with `DROP DATABASE`. **Never run it against collected
data.** For an existing install use the additive migration, which adds the
time-sync columns and tables without touching a single existing row:

```
mysql -u root -p sensor_dashboard < dashboard/migration_timesync.sql
```

It is idempotent, so running it twice is harmless. See the notes at the bottom
of that file for the optional `SensorLog` index and the MySQL settings worth
checking on the server (`innodb_buffer_pool_size` defaults to 128 MB, which is
far below the size of this table).

## Step 2
In backend terminal <dashboard\backend\\> <br><br>

Normal Dependencies:
```
npm init -y
npm install express mysql2 cors dotenv nodemon
```
Dev Dependency:
```
npm install -D nodemon
```

## Step 3
in <backend/package.json>
```
"scripts": {
  "start": "node server.js",
  "dev": "nodemon server.js"
}
```
While test:
```
npm start
```
While code:
```
npm run dev
```

## Step 4
In frontend terminal <dashboard\frontend\\>
```
npm init -y
npm install live-server
```

## Step 5
in <frontend/package.json>
```
"scripts": {
  "start": "live-server --host=0.0.0.0 --port=5500 --no-browser"
}
```
then run
```
npm start
```
then open
```
http://IP_of_pc_that_run_backend:5500/html/
```
or
```
http://localhost:5500/html/
```
if localhost

## Note 1
Change API in <frontend/js/config.js>
```
const API = "http://IP_of_pc_that_run_backend:5000/api"
```
Check by run
```
ipconfig
```
on backend pc




