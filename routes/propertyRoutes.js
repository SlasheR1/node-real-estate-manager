// routes/propertyRoutes.js
const express = require('express');
const multer = require('multer');
const firebaseService = require('../services/firebaseService');
// Middleware: базовая проверка роли и проверка принадлежности к компании
const { isLoggedIn, isAdmin, isAdminOrOwner } = require('../middleware/authMiddleware');
const { isCompanyMemberOrAdmin } = require('../middleware/companyMiddleware');
const admin = require('firebase-admin');
const db = admin.database();

const router = express.Router();

// --- Multer Setup --- (Без изменений)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) { cb(null, true); }
        else { cb(new Error('Разрешены только файлы изображений!'), false); }
    }
}).fields([
    { name: 'propertyImage', maxCount: 1 },
    { name: 'additionalImages', maxCount: 10 }
]);

// --- Middleware: isTenant --- (Без изменений)
function isTenant(req, res, next) {
    if (req.session.user && req.session.user.role === 'Tenant') {
        return next();
    }
    req.session.message = { type: 'error', text: 'Только арендаторы могут выполнять это действие.' };
    const backUrl = req.header('Referer') || '/';
    res.redirect(backUrl);
}

// --- GET / (был /properties) --- (Список объектов с фильтрацией по компании)
router.get('/', isLoggedIn, async (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    console.log("Accessing GET / (properties list) route"); // Обновлен лог для ясности
    const currentUser = req.session.user;

    try {
        // ... (вся логика фильтрации и рендеринга остается БЕЗ ИЗМЕНЕНИЙ) ...
        if (!currentUser) {
             console.warn("[GET /properties] No user in session. Redirecting to login.");
             return res.redirect('/login');
        }
        let properties = [];
        if (currentUser.role === 'Admin') {
            console.log("Fetching ALL properties for Admin...");
            properties = await firebaseService.getAllProperties();
        } else if ((currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId) {
            console.log(`Fetching properties for Company ID: ${currentUser.companyId}...`);
            properties = await firebaseService.getPropertiesByCompanyId(currentUser.companyId);
        } else if (currentUser.role === 'Tenant') {
             console.log("Fetching ALL properties for Tenant...");
             properties = await firebaseService.getAllProperties();
        } else {
             console.warn(`User ${currentUser.username} role ${currentUser.role} or companyId missing. Fetching no properties.`);
             properties = [];
        }
        const validProperties = Array.isArray(properties) ? properties : [];
        console.log(`Fetched ${validProperties.length} properties for user ${currentUser.username}.`);
        const propertiesWithImages = validProperties.map(prop => {
             if (!prop || !prop.Id) { console.warn("Skipping invalid property object in map."); return null; }
             let imageSrc = '/images/placeholder.png';
             if (prop.ImageData && typeof prop.ImageData === 'string') { try { let type = prop.ImageData.startsWith('/9j/')?'jpeg':'png'; imageSrc = `data:image/${type};base64,${prop.ImageData}`; } catch(e){} }
             let dailyPrice = 0;
             if (prop.Price != null && !isNaN(parseFloat(prop.Price))) { try { const m=parseFloat(prop.Price); if(m>0){const r=m/30; dailyPrice=Math.round(r/10)*10; if(dailyPrice<10&&r>0) dailyPrice=10;} } catch(e){} }
             let addedDateToSort = new Date(0);
             if (prop.AddedDate && !isNaN(new Date(prop.AddedDate))) { addedDateToSort = new Date(prop.AddedDate); }
             return { ...prop, DisplayImageSrc: imageSrc, CalculatedDailyPrice: dailyPrice, SortableAddedDate: addedDateToSort };
         }).filter(prop => prop !== null);
        console.log(`Processed ${propertiesWithImages.length} properties successfully.`);
        propertiesWithImages.sort((a, b) => b.SortableAddedDate.getTime() - a.SortableAddedDate.getTime());
        res.render('properties', {
            title: 'Объекты недвижимости',
            properties: propertiesWithImages,
            success: req.session.message?.type === 'success' ? req.session.message.text : null,
            error: req.session.message?.type === 'error' ? req.session.message.text : null
        });
        if (req.session.message) delete req.session.message;

    } catch (error) {
        console.error("[GET /properties] Error:", error);
        next(error);
    }
});

// --- GET /add (был /properties/add) --- (Показать форму добавления)
router.get('/add', isLoggedIn, isAdminOrOwner, async (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    try {
        // ... (логика проверки Owner'а и рендеринга остается БЕЗ ИЗМЕНЕНИЙ) ...
        if (req.session.user.role === 'Owner') {
            let userProfileComplete = req.session.user.companyProfileCompleted;
            if (!userProfileComplete) {
                 const dbUser = await firebaseService.getUserByUsername(req.session.user.username);
                 userProfileComplete = dbUser?.companyProfileCompleted === true;
                 if (userProfileComplete) {
                     req.session.user.companyProfileCompleted = true;
                     if(dbUser.companyName && !req.session.user.companyName) req.session.user.companyName = dbUser.companyName;
                     if(dbUser.companyId && !req.session.user.companyId) req.session.user.companyId = dbUser.companyId;
                 }
            }
            if (!userProfileComplete) {
                req.session.message = { type: 'warning', text: 'Пожалуйста, завершите настройку профиля компании.' };
                return req.session.save(err => res.redirect('/company/setup'));
            }
        }
        res.render('property-add-edit', {
            title: 'Добавить новый объект', property: { AdditionalImages: [] }, isEditMode: false,
            error: req.session.message?.type === 'error' ? req.session.message.text : null,
            success: req.session.message?.type === 'success' ? req.session.message.text : null
        });
        if (req.session.message) delete req.session.message;
    } catch (error) { console.error(`[GET /properties/add] Error:`, error); next(error); }
});

// --- POST /add (был /properties/add) --- (Обработка добавления)
router.post('/add', isLoggedIn, isAdminOrOwner, (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    upload(req, res, async (err) => {
        try {
            // ... (вся логика валидации, определения companyId, создания объекта и сохранения остается БЕЗ ИЗМЕНЕНИЙ) ...
            if (err) { if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') { throw new Error('Файл слишком большой.'); } throw err; }
            const { Title, Type, Price, Description, Address, Area, HasParking, HasWifi, HasBalcony, IsFurnished, IsAirConditioned, Bedrooms, Bathrooms } = req.body;
            if (!Title || !Type || !Price || !Address || !Area) { throw new Error('Заполните обязательные поля.'); }
            const priceNum = parseFloat(Price); const areaNum = parseFloat(Area);
            const bedroomsInt = parseInt(Bedrooms) || 0; const bathroomsInt = parseInt(Bathrooms) || 0;
            if (isNaN(priceNum) || priceNum <= 0 || isNaN(areaNum) || areaNum <= 0) { throw new Error('Цена и Площадь - полож. числа.'); }
            const ownerUsername = req.session.user.username;
            let ownerCompanyName = req.session.user.companyName;
            let companyId = req.session.user.companyId;
            if (req.session.user.role === 'Owner') {
                if (!companyId) {
                    console.error(`[POST /properties/add] CRITICAL: companyId could not be determined for user ${ownerUsername}`);
                    throw new Error("Не удалось определить компанию для привязки объекта.");
                }
                if (!ownerCompanyName){
                     const company = await firebaseService.getCompanyById(companyId);
                     ownerCompanyName = company?.companyName || ownerUsername;
                     req.session.user.companyName = ownerCompanyName;
                }
            } else if (req.session.user.role === 'Admin') {
                 companyId = req.session.user.companyId || ownerUsername;
                 ownerCompanyName = req.session.user.companyName || ownerUsername;
                 console.warn(`Admin ${ownerUsername} adding property. Assigned to companyId: ${companyId}`);
            } else { throw new Error("Недостаточно прав для добавления объекта."); }
            if (!companyId) { throw new Error("Не удалось определить компанию для привязки объекта."); }
            const newProperty = {
                Id: null, Title, Type, Price: priceNum, Description: Description || '', Address, Area: areaNum,
                IsAvailable: true, AddedDate: new Date().toISOString(),
                OwnerUsername: ownerUsername, CompanyName: ownerCompanyName, companyId: companyId,
                Rating: 0, NumberOfReviews: 0,
                HasParking: HasParking === 'on', HasWifi: HasWifi === 'on', HasBalcony: HasBalcony === 'on',
                IsFurnished: IsFurnished === 'on', IsAirConditioned: IsAirConditioned === 'on',
                Bedrooms: bedroomsInt, Bathrooms: bathroomsInt,
                ImageData: null, AdditionalInfo: '[]'
            };
            if (req.files?.propertyImage?.[0]) { newProperty.ImageData = req.files.propertyImage[0].buffer.toString('base64'); }
            const additionalImagesBase64 = [];
            if (req.files?.additionalImages?.length > 0) { req.files.additionalImages.forEach(file => additionalImagesBase64.push(file.buffer.toString('base64'))); }
            newProperty.AdditionalInfo = JSON.stringify(additionalImagesBase64);
            const savedProperty = await firebaseService.saveProperty(newProperty);
            console.log(`Property added by ${ownerUsername} TO COMPANY ${companyId}. Assigned ID: ${savedProperty.Id}`);
            req.session.message = { type: 'success', text: `Объект "${savedProperty.Title}" добавлен!` };
            // Редирект на общий список объектов
            req.session.save(err => res.redirect('/properties')); // <<< ИЗМЕНЕН РЕДИРЕКТ

        } catch (error) {
             console.error("Error POST /properties/add:", error);
             req.session.message = { type: 'error', text: error.message || 'Ошибка добавления.'};
             // Редирект обратно на форму добавления
             req.session.save(err => res.redirect('/properties/add')); // <<< ИЗМЕНЕН РЕДИРЕКТ
        }
    });
});

// --- GET /edit/:id (был /properties/edit/:id) --- (Show Edit Form)
router.get('/edit/:id', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    const propertyId = req.params.id;
    try {
        // ... (логика получения property и подготовки данных остается БЕЗ ИЗМЕНЕНИЙ) ...
        const property = await firebaseService.getPropertyById(propertyId);
        if (!property) { req.session.message = { type: 'error', text: 'Объект не найден.' }; return res.redirect('/properties'); } // Редирект на общий список
        let displayImageSrc = '/images/placeholder.png';
        if(property.ImageData && typeof property.ImageData === 'string'){try{let t=property.ImageData.startsWith('/9j/')?'jpeg':'png';displayImageSrc=`data:image/${t};base64,${property.ImageData}`}catch(e){}}
        let additionalImagesDataUrls=[];if(property.AdditionalInfo&&typeof property.AdditionalInfo === 'string'){try{const b=JSON.parse(property.AdditionalInfo);if(Array.isArray(b)){additionalImagesDataUrls=b.map(s=>{if(typeof s==='string'&&s.length>0){try{let t=s.startsWith('/9j/')?'jpeg':'png';return`data:image/${t};base64,${s}`}catch(e){return null}}return null}).filter(u=>u!==null)}}catch(e){}}
        res.render('property-add-edit', {
            title: `Редактировать: ${property.Title || propertyId}`,
            property: { Id: propertyId, ...property, DisplayImageSrc: displayImageSrc, AdditionalImages: additionalImagesDataUrls },
            isEditMode: true,
            error: req.session.message?.type === 'error' ? req.session.message.text : null,
            success: req.session.message?.type === 'success' ? req.session.message.text : null
        });
        if (req.session.message) delete req.session.message;
    } catch (error) { console.error(`Error GET /properties/edit/${propertyId}:`, error); next(error); }
});

// --- POST /edit/:id (был /properties/edit/:id) --- (Handle Editing)
router.post('/edit/:id', isLoggedIn, isCompanyMemberOrAdmin, (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    const propertyId = req.params.id;
    upload(req, res, async (err) => {
         try {
            // ... (вся логика валидации, получения currentProperty, обновления данных и сохранения остается БЕЗ ИЗМЕНЕНИЙ) ...
            if (err) { if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') { throw new Error('Файл слишком большой.'); } throw err; }
            const { Title, Type, Price, Description, Address, Area, IsAvailable, HasParking, HasWifi, HasBalcony, IsFurnished, IsAirConditioned, Bedrooms, Bathrooms } = req.body;
            let deleteImageIndices = req.body.deleteImageIndices || [];
            if (typeof deleteImageIndices === 'string') { deleteImageIndices = [deleteImageIndices]; }
            const numericIndicesToDelete = deleteImageIndices.map(i => parseInt(i)).filter(i => !isNaN(i) && i >= 0);
            if (!Title || !Type || !Price || !Address || !Area) { throw new Error('Заполните обязательные поля.'); }
            const priceNum = parseFloat(Price); const areaNum = parseFloat(Area);
            const bedroomsInt = parseInt(Bedrooms) || 0; const bathroomsInt = parseInt(Bathrooms) || 0;
            if (isNaN(priceNum) || priceNum <= 0 || isNaN(areaNum) || areaNum <= 0) { throw new Error('Цена и Площадь - полож. числа.'); }
            const currentProperty = await firebaseService.getPropertyById(propertyId);
            if (!currentProperty) { throw new Error('Объект не найден.'); }
            const updatedPropertyData = {
                ...currentProperty, Title, Type, Price: priceNum, Description: Description || '', Address, Area: areaNum,
                IsAvailable: IsAvailable === 'on', HasParking: HasParking === 'on', HasWifi: HasWifi === 'on',
                HasBalcony: HasBalcony === 'on', IsFurnished: IsFurnished === 'on', IsAirConditioned: IsAirConditioned === 'on',
                Bedrooms: bedroomsInt, Bathrooms: bathroomsInt, Id: propertyId
            };
            if (req.files?.propertyImage?.[0]) { updatedPropertyData.ImageData = req.files.propertyImage[0].buffer.toString('base64'); }
            else { updatedPropertyData.ImageData = currentProperty.ImageData; }
            let existingBase64Strings = []; if (currentProperty.AdditionalInfo && typeof currentProperty.AdditionalInfo === 'string') { try { existingBase64Strings = JSON.parse(currentProperty.AdditionalInfo); if(!Array.isArray(existingBase64Strings)) existingBase64Strings=[]; } catch { existingBase64Strings = []; } }
            const filteredImages = existingBase64Strings.filter((_, index) => !numericIndicesToDelete.includes(index));
            if (req.files?.additionalImages?.length > 0) { req.files.additionalImages.forEach(file => filteredImages.push(file.buffer.toString('base64'))); }
            updatedPropertyData.AdditionalInfo = JSON.stringify(filteredImages);
            await firebaseService.saveProperty(updatedPropertyData);
            console.log(`Property ${propertyId} updated successfully.`);
            req.session.message = { type: 'success', text: `Объект "${updatedPropertyData.Title}" обновлен!` };
            // Редирект на страницу деталей этого объекта
            req.session.save(err => res.redirect(`/properties/${propertyId}`)); // <<< ИЗМЕНЕН РЕДИРЕКТ

         } catch (error) {
              console.error(`Error POST /properties/edit/${propertyId}:`, error);
              req.session.message = { type: 'error', text: error.message || 'Ошибка обновления.'};
              // Редирект обратно на форму редактирования
              req.session.save(err => res.redirect(`/properties/edit/${propertyId}`)); // <<< ИЗМЕНЕН РЕДИРЕКТ
         }
    });
});

// --- POST /delete/:id (был /properties/delete/:id) --- (Delete Property)
router.post('/delete/:id', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    const propertyId = req.params.id;
    try {
        // ... (логика проверки, удаления и редиректа остается БЕЗ ИЗМЕНЕНИЙ) ...
        const property = await firebaseService.getPropertyById(propertyId);
        if (!property) { req.session.message = { type: 'info', text: 'Объект уже удален.' }; return req.session.save(err => res.redirect('/properties')); }
        await firebaseService.deleteProperty(propertyId);
        console.log(`Property ${propertyId} deleted by ${req.session.user.username}.`);
        req.session.message = { type: 'success', text: `Объект "${property.Title || propertyId}" удален.` };
        req.session.save(err => res.redirect('/properties')); // Редирект на общий список
    } catch (error) {
        console.error(`Error POST /properties/delete/${propertyId}:`, error);
        req.session.message = { type: 'error', text: 'Ошибка удаления.' };
        req.session.save(err => res.redirect('/properties')); // Редирект на общий список
    }
});

// --- GET /:id (был /properties/:id) --- (Property Details)
router.get('/:id', isLoggedIn, async (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    const propertyId = req.params.id;
    const currentUser = req.session.user;
    if (!currentUser) { return res.redirect('/login'); }
    try {
        // ... (логика получения property, reviews, определения прав и рендеринга остается БЕЗ ИЗМЕНЕНИЙ) ...
        const [property, reviews] = await Promise.all([
            firebaseService.getPropertyById(propertyId),
            firebaseService.getPropertyReviews(propertyId)
        ]);
        if (!property) { return res.status(404).render('error', { title: 'Объект не найден', message: `Объект с ID ${propertyId} не найден.` }); }
        const isMember = (currentUser.role === 'Owner' || currentUser.role === 'Staff') && currentUser.companyId === property.companyId;
        const isAdminUser = currentUser.role === 'Admin';
        const canEdit = isAdminUser || isMember;
        const canDelete = isAdminUser || isMember;
        const canBook = currentUser.role === 'Tenant' && property.IsAvailable === true;
        let canReview = false, userHasReviewed = false;
        if(currentUser.role === 'Tenant'){ try { userHasReviewed = await firebaseService.hasUserReviewedProperty(propertyId, currentUser.username); if (!userHasReviewed) canReview = true; } catch(e){} }
        console.log(`Permissions for ${propertyId}: Edit=${canEdit}, Delete=${canDelete}, Book=${canBook}, Review=${canReview}, HasReviewed=${userHasReviewed}`);
        let displayImageSrc = '/images/placeholder.png';
        if(property.ImageData && typeof property.ImageData === 'string'){try{let t=property.ImageData.startsWith('/9j/')?'jpeg':'png';displayImageSrc=`data:image/${t};base64,${property.ImageData}`}catch(e){}}
        let additionalImages=[];if(property.AdditionalInfo&&typeof property.AdditionalInfo === 'string'){try{const b=JSON.parse(property.AdditionalInfo);if(Array.isArray(b)){additionalImages=b.map(s=>{if(typeof s==='string'&&s.length>0){try{let t=s.startsWith('/9j/')?'jpeg':'png';return`data:image/${t};base64,${s}`}catch(e){return null}}return null}).filter(u=>u!==null)}}catch(e){}}
        let dailyPrice = 0; if (property.Price != null && !isNaN(parseFloat(property.Price))) { try { const m=parseFloat(property.Price); if(m>0){const r=m/30; dailyPrice=Math.round(r/10)*10; if(dailyPrice<10&&r>0) dailyPrice=10;} } catch(e){} }
        const sortedReviews = Array.isArray(reviews) ? reviews.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)) : [];
        res.render('property-details', {
            title: property.Title || 'Детали объекта',
            property: { Id: propertyId, ...property, DisplayImageSrc: displayImageSrc, AdditionalImages: additionalImages, CalculatedDailyPrice: dailyPrice },
            reviews: sortedReviews, canReview, userHasReviewed, canEdit, canDelete, canBook,
        });
    } catch (error) { console.error(`[GET /properties/:id] Error:`, error); next(error); }
});

// --- POST /:id/reviews (был /properties/:id/reviews) --- (Add Review)
router.post('/:id/reviews', isLoggedIn, isTenant, async (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    const propertyId = req.params.id;
    const { rating, comment } = req.body;
    const currentUser = req.session.user;
    try {
        // ... (логика валидации, сохранения отзыва и редиректа остается БЕЗ ИЗМЕНЕНИЙ) ...
        const numRating = parseInt(rating);
        if (!numRating || numRating < 1 || numRating > 5) throw new Error("Рейтинг от 1 до 5.");
        if (!comment?.trim()) throw new Error("Комментарий пуст.");
        if (comment.trim().length > 1000) throw new Error("Комментарий > 1000 симв.");
        const property = await firebaseService.getPropertyById(propertyId);
        if (!property) throw new Error("Объект не найден.");
        const hasReviewed = await firebaseService.hasUserReviewedProperty(propertyId, currentUser.username);
        if (hasReviewed) throw new Error("Вы уже оставили отзыв.");
        const reviewRef = db.ref(`properties/${propertyId}/reviews`).push();
        const newReviewId = reviewRef.key;
        const newReviewData = { reviewId: newReviewId, propertyId, userId: currentUser.username, username: currentUser.username, rating: numRating, comment: comment.trim(), createdAt: new Date().toISOString() };
        const currentReviews = await firebaseService.getPropertyReviews(propertyId);
        const allRatings = Array.isArray(currentReviews) ? currentReviews.map(r => r.rating) : [];
        allRatings.push(numRating);
        const newNumberOfReviews = allRatings.length;
        const sumOfRatings = allRatings.reduce((sum, r) => sum + (r || 0), 0);
        const newAverageRating = newNumberOfReviews > 0 ? parseFloat((sumOfRatings / newNumberOfReviews).toFixed(2)) : 0;
        const updates = {};
        updates[`/properties/${propertyId}/reviews/${newReviewId}`] = newReviewData;
        updates[`/properties/${propertyId}/Rating`] = newAverageRating;
        updates[`/properties/${propertyId}/NumberOfReviews`] = newNumberOfReviews;
        await db.ref().update(updates);
        req.session.message = { type: 'success', text: 'Отзыв добавлен!' };
        // Редирект обратно на страницу деталей
        res.redirect(`/properties/${propertyId}`); // <<< ИЗМЕНЕН РЕДИРЕКТ

    } catch (error) {
        console.error(`[Review POST] Error for ${propertyId} by ${currentUser.username}:`, error);
        req.session.message = { type: 'error', text: error.message || 'Не удалось добавить отзыв.' };
        res.redirect(`/properties/${propertyId}`); // <<< ИЗМЕНЕН РЕДИРЕКТ
    }
});

// --- POST /:propertyId/reviews/:reviewId/delete (был /properties/:propertyId/reviews/:reviewId/delete) --- (Delete Review)
router.post('/:propertyId/reviews/:reviewId/delete', isLoggedIn, isAdmin, async (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    const { propertyId, reviewId } = req.params;
    try {
        // ... (логика удаления отзыва и ответа остается БЕЗ ИЗМЕНЕНИЙ) ...
        const reviewRef = db.ref(`properties/${propertyId}/reviews/${reviewId}`);
        const reviewSnapshot = await reviewRef.once('value');
        if (!reviewSnapshot.exists()) { return res.status(404).json({ success: false, error: 'Отзыв не найден.' }); }
        const remainingReviewsSnapshot = await db.ref(`properties/${propertyId}/reviews`).once('value');
        const remainingReviewsData = remainingReviewsSnapshot.val();
        let newAverageRating = 0; let newNumberOfReviews = 0;
        if (remainingReviewsData) {
            const remainingReviewsArray = Object.values(remainingReviewsData).filter(r => r.reviewId !== reviewId);
            newNumberOfReviews = remainingReviewsArray.length;
            if (newNumberOfReviews > 0) { const sumOfRatings = remainingReviewsArray.reduce((sum, r) => sum + (r.rating || 0), 0); newAverageRating = parseFloat((sumOfRatings / newNumberOfReviews).toFixed(2)); }
        }
        const updates = {};
        updates[`/properties/${propertyId}/reviews/${reviewId}`] = null;
        updates[`/properties/${propertyId}/Rating`] = newAverageRating;
        updates[`/properties/${propertyId}/NumberOfReviews`] = newNumberOfReviews;
        await db.ref().update(updates);
        res.status(200).json({ success: true, message: 'Отзыв удален.', newRating: newAverageRating, newReviewCount: newNumberOfReviews });
    } catch (error) {
        console.error(`[Review Delete POST] Error for review ${reviewId}:`, error);
        res.status(500).json({ success: false, error: 'Ошибка сервера.' });
    }
});

// --- DELETE /:id/image/main (был /properties/:id/image/main) --- (Delete Main Image)
router.delete('/:id/image/main', isLoggedIn, isCompanyMemberOrAdmin, async (req, res, next) => { // <<< ИЗМЕНЕН ПУТЬ
    const propertyId = req.params.id;
    try {
        // ... (логика удаления изображения и ответа остается БЕЗ ИЗМЕНЕНИЙ) ...
        const propertyExists = await firebaseService.getPropertyById(propertyId);
        if (!propertyExists) { return res.status(404).json({ success: false, message: "Объект не найден." }); }
        await db.ref(`properties/${propertyId}`).update({ ImageData: null });
        console.log(`Main image deleted for property ${propertyId}`);
        res.status(200).json({ success: true, message: "Основное изображение удалено." });
    } catch (error) {
        console.error(`Error DELETE main image for ${propertyId}:`, error);
        res.status(500).json({ success: false, message: error.message || "Ошибка сервера." });
    }
});

module.exports = router;