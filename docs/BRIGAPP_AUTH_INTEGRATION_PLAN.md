# План интеграции авторизации и разграничения прав доступа: RackStudio и BrigApp

## 1. Введение и текущее состояние

На текущий момент RackStudio функционирует как автономное SPA-приложение (Single Page Application), сохраняющее данные в локальном хранилище браузера (`localStorage`) и при наличии бэкенда синхронизирующееся через REST API. 

При запуске через скрипт `start.bat` (`python -m http.server 8080`) доступ к приложению открыт любому пользователю локальной сети без проверки подлинности и пароля. Любой подключившийся пользователь может удалять, перемещать оборудование, изменять коммутацию и удалять стойки.

Для устранения этого риска разработана концепция интеграции RackStudio с корпоративной системой **BrigApp** (`C:\Users\User\IdeaProjects\BrigApp`), в которой уже реализована авторизация, база пользователей и ролевая модель.

---

## 2. Анализ существующего задела в BrigApp

В кодовой базе проекта BrigApp (Spring Boot, Vaadin Flow, Spring Security, H2 Database) уже заложен базовый архитектурный каркас для интеграции:

1. **Раздача статических файлов**:
   - Класс `ru.markov.application.config.StaticResourceConfig` маппит путь `/rackstudio-app/**` напрямую на директорию проекта `file:C:/Users/User/Desktop/RackStudio-main/`. Это позволяет обновлять RackStudio независимо от пересборки JAR-файла BrigApp.
2. **Встраивание интерфейса в Vaadin**:
   - Класс `ru.markov.application.views.RackStudioView` объявляет маршрут `@Route("rackstudio")` с защитой `@RolesAllowed({"ADMIN", "TECH", "TECH_READER"})` и отображает RackStudio во весь экран через `IFrame("/rackstudio-app/index.html")`.
3. **Серверное хранилище проектов**:
   - Класс `ru.markov.application.service.RackStudioService` управляет чтением и атомарной записью общего файла `state.json` с созданием резервной копии `state.backup.json`.
4. **Сетевой контроллер**:
   - Класс `ru.markov.application.controller.RackStudioApiController` предоставляет эндпоинты:
     - `GET /rackstudio-api/state` — получение централизованного состояния проекта.
     - `GET /rackstudio-api/state/version` — получение timestamp последнего изменения для поллинга.
     - `POST /rackstudio-api/state` — сохранение нового состояния проекта на сервере.
5. **Клиентская синхронизация в RackStudio**:
   - В [js/state.js](file:///c:/Users/User/Desktop/RackStudio-main/js/state.js) реализована логика работы с сервером (`apiBase = '/rackstudio-api'`), отправка изменений с дебаунсом (400 мс) и фоновый поллинг обновлений.

---

## 3. Выявленные уязвимости и пробелы в безопасности

1. **Прямой неконтролируемый доступ по порту 8080**:
   При запуске через `start.bat` приложение обходит Spring Security BrigApp. Любой пользователь может открыть приложение напрямую и редактировать локальную копию.
2. **Отсутствие проверки прав на запись в `RackStudioApiController`**:
   В `SecurityConfig.java` доступ к путям `/rackstudio-app/**` и `/rackstudio-api/**` открыт ролям `ADMIN`, `TECH` и `TECH_READER`. В контроллере метод `@PostMapping("/state")` не проверяет конкретную роль. В результате наблюдатель с ролью `TECH_READER` имеет техническую возможность перезаписать центральный файл `state.json`.
3. **Отсутствие режима «Только чтение» (Read-Only) в интерфейсе RackStudio**:
   Клиентское приложение не запрашивает информацию о вошедшем пользователе и его полномочиях. Элементы управления (перетаскивание устройств, удаление кабелей, очистка и удаление стоек) остаются активными для всех.
4. **Отсутствие информирования о текущей сессии**:
   В REST API BrigApp отсутствует легковесный эндпоинт для проверки статуса аутентификации (например, `/rackstudio-api/me`), из-за чего фронтенд не может определить имя пользователя и его права.

---

## 4. Матрица разграничения доступа (RBAC Matrix)

| Действие в системе | Неавторизованный пользователь | Роль `TECH_READER` (Наблюдатель) | Роли `TECH`, `ADMIN` (Инженер / Администратор) |
| :--- | :---: | :---: | :---: |
| Вход в приложение | Запрещен (экран блокировки) | Разрешен | Разрешен |
| Просмотр монтажных схем стоек | Запрещен | Разрешен | Разрешен |
| Просмотр логической топологии | Запрещен | Разрешен | Разрешен |
| Просмотр журнала подключений кабелей | Запрещен | Разрешен | Разрешен |
| Экспорт и печать паспорта в PDF | Запрещен | Разрешен | Разрешен |
| Фильтрация по рабочим группам | Запрещен | Разрешен | Разрешен |
| Монтаж и перетаскивание оборудования | Запрещен | Запрещено | Разрешено |
| Прокладка и удаление патч-кордов | Запрещен | Запрещено | Разрешено |
| Добавление, редактирование, удаление стоек | Запрещен | Запрещено | Разрешено |
| Создание и редактирование шаблонов | Запрещен | Запрещено | Разрешено |
| Сохранение схемы на сервер (`POST /state`) | Запрещен (401) | Запрещено (403 Forbidden) | Разрешено (200 OK) |

---

## 5. Пошаговый план технической реализации

### Этап 1. Доработка бэкенда BrigApp (`C:\Users\User\IdeaProjects\BrigApp`)

1. **Добавление эндпоинта информации о пользователе в `RackStudioApiController.java`**:
   ```java
   @GetMapping(value = "/me", produces = MediaType.APPLICATION_JSON_VALUE)
   public ResponseEntity<Map<String, Object>> getCurrentUser() {
       Authentication auth = SecurityContextHolder.getContext().getAuthentication();
       if (auth == null || !auth.isAuthenticated() || "anonymousUser".equals(auth.getPrincipal())) {
           return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
       }
       boolean canEdit = auth.getAuthorities().stream()
               .anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN") || a.getAuthority().equals("ROLE_TECH"));
       
       String role = auth.getAuthorities().stream()
               .map(GrantedAuthority::getAuthority)
               .findFirst().orElse("USER");

       Map<String, Object> result = new HashMap<>();
       result.put("authenticated", true);
       result.put("username", auth.getName());
       result.put("role", role.replace("ROLE_", ""));
       result.put("canEdit", canEdit);
       return ResponseEntity.ok(result);
   }
   ```

2. **Защита эндпоинта сохранения на уровне метода или SecurityConfig**:
   В `RackStudioApiController.java`:
   ```java
   @PostMapping(value = "/state", consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
   public ResponseEntity<?> saveState(@RequestBody String stateJson) {
       Authentication auth = SecurityContextHolder.getContext().getAuthentication();
       boolean canEdit = auth != null && auth.getAuthorities().stream()
               .anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN") || a.getAuthority().equals("ROLE_TECH"));
       if (!canEdit) {
           return ResponseEntity.status(HttpStatus.FORBIDDEN)
                   .body(Collections.singletonMap("error", "Недостаточно прав для редактирования стоек"));
       }
       // Сохранение состояния...
   }
   ```

3. **Обновление `SecurityConfig.java`**:
   - `GET /rackstudio-api/state`, `GET /rackstudio-api/version`, `GET /rackstudio-api/me` — разрешены `hasAnyRole("ADMIN", "TECH", "TECH_READER")`.
   - `POST /rackstudio-api/state` — разрешен строго `hasAnyRole("ADMIN", "TECH")`.

---

### Этап 2. Внедрение режима «Только чтение» и сессии в RackStudio

1. **Запрос профиля в `js/state.js`**:
   - При инициализации `initServerSync()` отправлять запрос `GET /rackstudio-api/me`.
   - Сохранять состояние авторизации: `currentUser = { username, role, canEdit }`.
   - Оповещать слушателей об изменении профиля пользователя.

2. **Режим блокировки изменений в `js/app.js` и `js/rack-renderer.js`**:
   - Если `canEdit === false`:
     - Скрывать или делать неактивными кнопки:
       - Добавление стойки (`#btn-add-rack`, `#btn-sidebar-add-rack`).
       - Редактирование и удаление стойки (`#btn-edit-rack`, `#btn-clone-rack-modal`, `#btn-delete-rack-modal`).
       - Добавление устройств (`#btn-catalog`, кнопки добавления в пустых слотах).
       - Добавление рабочих групп (`#btn-add-group`).
       - Удаление кабелей (`#btn-drawer-delete-cable`, клавиша Delete).
       - Конструктор шаблонов (`#btn-template-builder`).
     - Отключать перетаскивание устройств (`draggable = false`, блокировка обработчиков drag-and-drop).
     - Блокировать инициализацию новых патч-кордов при клике по портам (клик по порту открывает инспектор подключенного кабеля или показывает информацию о порте без режима трассировки).
     - В верхней панели отображать бейдж: `Режим просмотра (Пользователь: <username>, Роль: TECH_READER)`.

3. **Защита от открытия без авторизации**:
   - Если `GET /rackstudio-api/me` возвращает 401 или ошибка сети (вне фрейма BrigApp):
     - Показать экран блокировки:
       `Доступ ограничен. Для работы с серверными стойками необходимо войти в систему BrigApp.`
     - Предоставить кнопку: `Войти в BrigApp` с переходом на `/login`.

---

### Этап 3. Регламент промышленного запуска (Production Deployment)

1. **Выключение автономного сервера**:
   - В боевой эксплуатации исключить запуск `python -m http.server 8080`.
   - Доступ к RackStudio осуществлять строго через единый порт BrigApp (`http://<server-ip>:8099/rackstudio`).
2. **Логирование действий**:
   - При каждом вызове `POST /rackstudio-api/state` логировать в `app.log` имя пользователя BrigApp, внесшего изменения, размер файла и статус создания резервной копии.
