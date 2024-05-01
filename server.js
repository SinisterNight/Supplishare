require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const { Pool } = require('pg');
const cors = require('cors');
const mime = require('mime-types');

const app = express();
const PORT = 5000;


app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());


// Set up Azure Blob Storage client
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(process.env.AZURE_CONTAINER_NAME);

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Configure Multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Upload image to Azure Blob Storage and insert data into the database
app.post('/uploadimage', upload.array('image'), async (req, res) => {
  try {
    const { title, description, zip, itemcategory, email } = req.body;

    if (!title || !description || !zip || !itemcategory || !email) {
      return res.status(400).send('Title, description, zip, itemcategory, and email are required.');
    }

    const files = req.files;
    const listingname = title; // Using title as listingname

    if (!files || files.length === 0) {
      return res.status(400).send('No files uploaded.');
    }

    const blobUrls = await Promise.all(files.map(async (file) => {
      // Check MIME type
      const mimeType = mime.lookup(file.originalname);
      if (!mimeType.startsWith('image/')) {
        throw new Error('Invalid file type. Please upload only images.');
      }

      const blobName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.jpg`; // Use a more unique name if needed
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // Upload the file to Azure Blob Storage
      await blockBlobClient.upload(file.buffer, file.buffer.length);

      return blockBlobClient.url; // Return the Blob Storage URL
    }));

    // Insert listing details using insertListingDetails function
    const listingResult = await insertListingDetails(email, listingname, description, zip, blobUrls, itemcategory);

    // Modify the response to include details about the uploaded data
    res.send({
      message: 'Title and description received successfully. Files uploaded successfully.',
      uploadedData: {
        listingname,
        description,
        zip,
        itemcategory,
        email,
        urls: blobUrls,
      },
      listingResult, // Include the result of inserting listing details in the response
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).send('Error during file upload.');
  }
});

async function insertListingDetails(email, listingname, description, zipcode, imageUrls, itemcategory) {
  const client = await pool.connect();

  try {
    // Start a transaction
    await client.query('BEGIN');

    // Step 1: Retrieve the UserID based on the email
    const userQuery = 'SELECT userid FROM supplishare.users WHERE email = $1';
    const userResult = await client.query(userQuery, [email]);
    if (userResult.rows.length === 0) {
      throw new Error('User not found.');
    }
    const userID = userResult.rows[0].userid;

    // Step 2: Insert into Listings table without setting ImageCount initially
    const insertListingQuery = `
      INSERT INTO supplishare.listings (listingname, description, zipcode, status, userid, itemcategory)
      VALUES ($1, $2, $3, 'Active', $4, $5) RETURNING listingid;
    `;
    const listingValues = [listingname, description, zipcode, userID, itemcategory];
    const listingResult = await client.query(insertListingQuery, listingValues);
    const listingid = listingResult.rows[0].listingid;

    // Step 3: Insert each image URL into the ImageURL table
    for (const imageUrl of imageUrls) {
      const insertImageUrlQuery = `
        INSERT INTO supplishare.imageurl (listingid, imageurl)
        VALUES ($1, $2);
      `;
      await client.query(insertImageUrlQuery, [listingid, imageUrl]);
    }

    // Step 4: Update the ImageCount for the listing
    const updateImageCountQuery = `
      UPDATE SuppliShare.listings
      SET imagecount = (SELECT COUNT(*) FROM supplishare.imageurl WHERE listingid = $1)
      WHERE listingid = $1;
    `;
    await client.query(updateImageCountQuery, [listingid]);

    // Commit the transaction
    await client.query('COMMIT');

    return {
      success: true,
      message: `Successfully uploaded listing details and associated images.`,
      listingid,
      listingname,
      description,
      zipcode,
      itemcategory,
      imageurl,
	  userid,
    };
  } catch (error) {
    // Rollback the transaction in case of an error
    await client.query('ROLLBACK');
    console.error('Transaction Error:', error.message);
    return { success: false, message: error.message };
  } finally {
    // Release the client back to the pool
    client.release();
  }
}



async function insertImageDetails(itemType, description, zipcode, blobUrl, itemcategory) {
  const client = await pool.connect();

  try {
    const trimmedBlobUrl = blobUrl.map(url => url.replace(/^\{|\}$/g, ''));

    const insertQuery = `
      INSERT INTO Items (ItemType, Description, zipcode, ItemPictureURL, itemcategory)
      VALUES ($1, $2, $3, $4, $5)
    `;
    const values = [itemType, description, zipcode, trimmedBlobUrl, itemcategory];
    await client.query(insertQuery, values);

    // Update existing records to trim itempictureurl
    const updateQuery = `
      UPDATE Items
      SET ItemPictureURL = TRIM(BOTH '"{}"' FROM ItemPictureURL)
    `;
    await client.query(updateQuery);

    return {
      success: true,
      message: `Successfully uploaded backend insertimagedetails ItemType: ${itemType}, Description: ${description}, zipcode: ${zipcode}, ItemPictureURL: ${trimmedBlobUrl}, itemcategory: ${itemcategory}`,
      itemType,
      description,
      blobUrl: trimmedBlobUrl,
      zipcode,
	  itemcategory,
	  
    };
  } catch (error) {
    console.error('Database Insert Error:', error);
    throw new Error('Error during database insertion.');
  } finally {
    // Release the client back to the pool
    client.release();
  }
}
app.get('/api/listings', async (req, res) => {
  try {
    const listings = await fetchListingsWithDetails();
    res.json(listings);
  } catch (error) {
    res.status(500).send('Error fetching listings from the database.');
  }
});

async function fetchListingsWithDetails() {
  const client = await pool.connect();

  try {
    // Query to fetch listings and user details
    const listingsQuery = 
      `SELECT 
        l.listingid, l.listingname, l.description, l.zipcode, l.itemcategory, 
        u.email AS username
      FROM 
        supplishare.listings l
      JOIN 
        supplishare.users u ON l.userid = u.userid;`
    ;

    const { rows: listings } = await client.query(listingsQuery);

    // For each listing, fetch associated image URLs
    for (const listing of listings) {
      const imagesQuery = 
        `SELECT imageurl 
        FROM supplishare.imageurl 
        WHERE listingid = $1;`
      ;
      const { rows: images } = await client.query(imagesQuery, [listing.listingid]);

      // Adding image URLs array to each listing object
      listing.imageurls = images.map(img => img.imageurl);
    }

    return listings; // This array now includes each listing's details and image URLs
  } catch (error) {
    console.error('Error fetching listings and images:', error);
    throw error;
  } finally {
    client.release();
  }
}

app.get('/api/listings/postimages/:listingid', async (req, res) => {
  const listingId = req.params.listingid;

  const client = await pool.connect();

  try {
    const imagesQuery = `
      SELECT imageurl 
      FROM supplishare.imageurl 
      WHERE listingid = $1;
    `;
    const { rows: images } = await client.query(imagesQuery, [listingId]);

    const imageUrls = images.map(img => img.imageurl);
    res.json(imageUrls);
  } catch (error) {
    console.error('Error fetching images for listing:', error);
    res.status(500).send('Error fetching images for listing.');
  } finally {
    client.release();
  }
});




// Endpoint to get a list of items
app.get('/items', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = 'SELECT listingname, Description, zipcode, ItemPictureURL, itemcategory FROM Items';
    const { rows } = await client.query(query);

    client.release();

    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving items from the database');
  }
});
app.get('/listing/:listingID/userID', async (req, res) => {
  try {
    const { listingID } = req.params;
    const client = await pool.connect();
    const query = 'SELECT userID FROM supplishare.listings WHERE listingID = $1';
    const { rows } = await client.query(query, [listingID]);
    client.release();
    if (rows.length === 0) {
      // If no matching listingID is found, return 404 Not Found
      res.status(404).send('Listing not found');
    } else {
      // Send the userID associated with the listingID
      res.status(200).json(rows[0].userID);
    }
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving userID for the listing');
  }
});
// Endpoint to get items listed by a specific user
app.get('/user-items/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const client = await pool.connect();
    const result = await client.query('SELECT * FROM ListItems WHERE UserID = $1', [userId]);
    client.release();

    res.status(200).json(result.rows);
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving items for the user');
  }
});

app.get('/items/images', async (req, res) => {
  try {
    const client = await pool.connect();

    // Query to select image URLs from supplishare.url
    const imageUrlQuery = 'SELECT ItemPictureURL FROM supplishare.url WHERE Status = $1';
    const imageUrlResult = await client.query(imageUrlQuery, ['Accepted']);
    const imageUrls = imageUrlResult.rows.map(row => row.itempictureurl);

    // Query to select listing IDs from supplishare.listing
    const listingIdQuery = 'SELECT listingid FROM supplishare.listing WHERE Status = $1';
    const listingIdResult = await client.query(listingIdQuery, ['Accepted']);
    const listingIds = listingIdResult.rows.map(row => row.listingid);

    client.release();

    // Combine image URLs and listing IDs into an array of objects
    const imageData = imageUrls.map((url, index) => ({
      itempictureurl: url,
      listingid: listingIds[index]
    }));

    res.status(200).json(imageData);
  } catch (error) {
    console.error('Error fetching image URLs and listing IDs:', error);
    res.status(500).send('Failed to retrieve image URLs and listing IDs');
  }
});

app.get('/api/admin/user-count', async (req, res) => {
  try {
    const queryResult = await pool.query('SELECT COUNT(*) FROM Users');
    const userCount = queryResult.rows[0].count;
    res.status(200).json({ userCount });
  } catch (error) {
    console.error('Error fetching user count:', error);
    res.status(500).send('Failed to retrieve user count');
  }
});

async function deletePost(itemType) {
  try {
    const query = {
      text: 'DELETE FROM Items WHERE ItemType = $1',
      values: [itemType],
    };
    const result = await pool.query(query);
    return result.rowCount; // Return the number of rows deleted
  } catch (error) {
    throw new Error('Error deleting post: ' + error.message);
  }
}

app.delete('/deletePost/:itemType', async (req, res) => {
  const { itemType } = req.params; // Extract the itemType from the request parameters
  try {
    const deleteCount = await deletePost(itemType);
    if (deleteCount > 0) {
      res.status(200).json({ message: 'Item deleted successfully' });
    } else {
      res.status(404).json({ error: 'No item found with the specified itemType' });
    }
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});
app.delete('/deletePostById/:itemid', async (req, res) => {
  const { itemid } = req.params; // Extract the itemId from the request parameters
  try {
    const deleteCount = await deletePostById(itemid);
    if (deleteCount > 0) {
      res.status(200).json({ message: 'Item deleted successfully' });
    } else {
      res.status(404).json({ error: 'No item found with the specified itemId' });
    }
  } catch (error) {
    console.error('Error deleting post by ID:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

async function deletePostById(itemId) {
  try {
    console.log('Received itemId:', itemId);

    // Parse the itemId as an integer
    const itemIdInt = parseInt(itemId, 10);
    console.log('Parsed itemId:', itemIdInt);

    // Check if the parsed itemId is a valid integer
    if (isNaN(itemIdInt)) {
      throw new Error('Invalid itemId');
    }

    const query = {
      text: 'DELETE FROM Items WHERE itemid = $1',
      values: [itemIdInt],
    };
    const result = await pool.query(query);
    return result.rowCount; // Return the number of rows deleted
  } catch (error) {
    throw new Error('Error deleting post by ID: ' + error.message);
  }
}



app.get('/getItemId/:itemType', async (req, res) => {
  const { itemType } = req.params; // Extract the itemType from the request parameters
  try {
    // Query to select the itemid associated with the specified itemType
    const selectQuery = {
      text: 'SELECT itemid FROM Items WHERE ItemType = $1',
      values: [itemType],
    };

    const client = await pool.connect();
    const selectResult = await client.query(selectQuery);
    const itemId = selectResult.rows[0]?.itemid; // Get the itemid from the query result

    if (!itemId) {
      return res.status(404).json({ error: 'No item found with the specified itemType' });
    }

    res.status(200).json({ itemId });
  } catch (error) {
    console.error('Error retrieving item ID:', error);
    res.status(500).json({ error: 'Failed to retrieve item ID' });
  }
});

app.get('/imageCount', async (req, res) => {
  try {
    // Query to count the number of images in the ItemPictureURL column
    const countQuery = {
      text: 'SELECT COUNT(*) FROM Items WHERE ItemPictureURL IS NOT NULL',
    };

    // Execute the query using the database connection pool
    const client = await pool.connect();
    const countResult = await client.query(countQuery);

    // Extract the count from the query result
    const imageCount = countResult.rows[0]?.count || 0;

    // Return the count as JSON in the response
    res.status(200).json({ imageCount });
  } catch (error) {
    console.error('Error retrieving image count:', error);
    res.status(500).json({ error: 'Failed to retrieve image count' });
  }
});

app.get('/api/admin/userData', async (req, res) => {
  try {
    const queryResult = await pool.query('SELECT * FROM Users');
    const userData = queryResult.rows;
    res.status(200).json({ userData });
  } catch (error) {
    console.error('Error fetching user data:', error);
    res.status(500).send('Failed to retrieve user data');
  }
});

// Endpoint to get a list of items sorted by zipcode in ascending order
app.get('/items/sort/zipcode/ascending', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = 'SELECT ItemType, Description, zipcode, ItemPictureURL FROM Items ORDER BY zipcode ASC';
    const { rows } = await client.query(query);

    client.release();

    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});

// Endpoint to get a list of items sorted by zipcode in descending order
app.get('/items/sort/zipcode/descending', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = 'SELECT ItemType, Description, zipcode, ItemPictureURL FROM Items ORDER BY zipcode DESC';
    const { rows } = await client.query(query);

    client.release();

    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});

app.get('/api/listings/sort/dateposted/asc', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = `
      SELECT 
        l.listingid, 
        l.listingname, 
        l.description, 
        l.zipcode, 
        l.itemcategory, 
        u.email AS username, 
        ARRAY_AGG(i.imageurl) AS imageurls, -- Aggregate image URLs into an array
        l.dateposted
      FROM 
        supplishare.listings l
      LEFT JOIN 
        supplishare.users u ON l.userid = u.userid
      LEFT JOIN 
        supplishare.imageurl i ON l.listingid = i.listingid
      GROUP BY 
        l.listingid, l.listingname, l.description, l.zipcode, l.itemcategory, u.email, l.dateposted
      ORDER BY 
        l.dateposted ASC;
    `;
    const { rows } = await client.query(query);
    client.release();
    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});

// Endpoint to get a list of items sorted by dateposted in descending order
app.get('/api/listings/sort/dateposted/desc', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = `
      SELECT 
        l.listingid, 
        l.listingname, 
        l.description, 
        l.zipcode, 
        l.itemcategory, 
        u.email AS username, 
        ARRAY_AGG(i.imageurl) AS imageurls, -- Aggregate image URLs into an array
        l.dateposted
      FROM 
        supplishare.listings l
      LEFT JOIN 
        supplishare.users u ON l.userid = u.userid
      LEFT JOIN 
        supplishare.imageurl i ON l.listingid = i.listingid
      GROUP BY 
        l.listingid, l.listingname, l.description, l.zipcode, l.itemcategory, u.email, l.dateposted
      ORDER BY 
        l.dateposted desc;
    `;
    const { rows } = await client.query(query);
    client.release();
    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});


app.delete('/api/listings/delete', async (req, res) => {
  try {
    const { listingid } = req.body; // Assuming listingid is sent in the request body
    const client = await pool.connect();
    
    // Delete from imageurl table
    const deleteImageUrlQuery = `
      DELETE FROM
        supplishare.imageurl
      WHERE listingid = $1;
    `;
    await client.query(deleteImageUrlQuery, [listingid]);

    // Delete from listings table
    const deleteListingsQuery = `
      DELETE FROM
        supplishare.listings
      WHERE listingid = $1;
    `;
    await client.query(deleteListingsQuery, [listingid]);

    client.release();
    res.status(200).json({ message: 'Deleted successfully' });
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error deleting items from the database');
  }
});
app.get('/api/listings/sort/zipcode/asc', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = `
      SELECT 
        l.listingid, 
        l.listingname, 
        l.description, 
        l.zipcode, 
        l.itemcategory, 
        u.email AS username, 
        ARRAY_AGG(i.imageurl) AS imageurls, -- Aggregate image URLs into an array
        l.dateposted
      FROM 
        supplishare.listings l
      LEFT JOIN 
        supplishare.users u ON l.userid = u.userid
      LEFT JOIN 
        supplishare.imageurl i ON l.listingid = i.listingid
      GROUP BY 
        l.listingid, l.listingname, l.description, l.zipcode, l.itemcategory, u.email, l.dateposted
      ORDER BY 
        l.zipcode ASC;
    `;
    const { rows } = await client.query(query);
    client.release();
    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});

app.get('/api/listings/sort/zipcode/desc', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = `
      SELECT 
        l.listingid, 
        l.listingname, 
        l.description, 
        l.zipcode, 
        l.itemcategory, 
        u.email AS username, 
        ARRAY_AGG(i.imageurl) AS imageurls, -- Aggregate image URLs into an array
        l.dateposted
      FROM 
        supplishare.listings l
      LEFT JOIN 
        supplishare.users u ON l.userid = u.userid
      LEFT JOIN 
        supplishare.imageurl i ON l.listingid = i.listingid
      GROUP BY 
        l.listingid, l.listingname, l.description, l.zipcode, l.itemcategory, u.email, l.dateposted
      ORDER BY 
        l.zipcode desc;
    `;
    const { rows } = await client.query(query);
    client.release();
    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});


app.get('/api/listings/sort/itemcategory/asc', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = `
      SELECT 
        l.listingid, 
        l.listingname, 
        l.description, 
        l.zipcode, 
        l.itemcategory, 
        u.email AS username, 
        ARRAY_AGG(i.imageurl) AS imageurls, -- Aggregate image URLs into an array
        l.dateposted
      FROM 
        supplishare.listings l
      LEFT JOIN 
        supplishare.users u ON l.userid = u.userid
      LEFT JOIN 
        supplishare.imageurl i ON l.listingid = i.listingid
      GROUP BY 
        l.listingid, l.listingname, l.description, l.zipcode, l.itemcategory, u.email, l.dateposted
      ORDER BY 
        l.itemcategory ASC;
    `;
    const { rows } = await client.query(query);
    client.release();
    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});

app.get('/api/listings/sort/itemcategory/desc', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = `
      SELECT 
        l.listingid, 
        l.listingname, 
        l.description, 
        l.zipcode, 
        l.itemcategory, 
        u.email AS username, 
        ARRAY_AGG(i.imageurl) AS imageurls, -- Aggregate image URLs into an array
        l.dateposted
      FROM 
        supplishare.listings l
      LEFT JOIN 
        supplishare.users u ON l.userid = u.userid
      LEFT JOIN 
        supplishare.imageurl i ON l.listingid = i.listingid
      GROUP BY 
        l.listingid, l.listingname, l.description, l.zipcode, l.itemcategory, u.email, l.dateposted
      ORDER BY 
        l.itemcategory DESC;
    `;
    const { rows } = await client.query(query);
    client.release();
    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});
// Endpoint to get a list of items sorted by itemcategory in ascending order
app.get('/items/sort/itemcategory/ascending', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = 'SELECT ItemType, Description, zipcode, ItemPictureURL FROM Items ORDER BY itemcategory ASC';
    const { rows } = await client.query(query);

    client.release();

    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});

// Endpoint to get a list of items sorted by itemcategory in descending order
app.get('/items/sort/itemcategory/descending', async (req, res) => {
  try {
    const client = await pool.connect();
    const query = 'SELECT ItemType, Description, zipcode, ItemPictureURL FROM Items ORDER BY itemcategory DESC';
    const { rows } = await client.query(query);

    client.release();

    res.status(200).json(rows); // Send the fetched rows as JSON response
  } catch (error) {
    console.error('Database Query Error:', error);
    res.status(500).send('Error retrieving sorted items from the database');
  }
});




  
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});