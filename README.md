# Link
https://github.com/Omelettae/dht22

# Version
| Server | Sensor | Database |
| ------ | ------ | ------ |
| v2.0.0 | v2.0.0 | v2.0.0 |   
| v1.1.2 | v1.0.0 | v1.0.0 |
| v1.1.1 | v1.0.0 | v1.0.0 |
| v1.1.0 | v1.0.0 | v1.0.0 |

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




