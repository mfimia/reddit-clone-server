import { User } from "../entities/User";
import { MyContext } from "../types";
import {
  Resolver,
  Mutation,
  Arg,
  Field,
  Ctx,
  ObjectType,
  Query,
} from "type-graphql";
import argon2 from "argon2";
import { COOKIE_NAME, FORGET_PASSWORD_PREFIX } from "../constants";
import { UsernamePasswordInput } from "./UsernamePasswordInput";
import { validateRegister } from "../utils/validateRegister";
import { sendEmail } from "../utils/sendEmail";
import { v4 } from "uuid";

// We will return this object everytime there is an error
// Error contains two properties: field of the error and message
@ObjectType()
class FieldError {
  @Field()
  field: string;

  @Field()
  message: string;
}

// Object type for returns
// Returns error array if errors, or user type if user
// Contains the Field error and user that we created
@ObjectType()
class UserResponse {
  @Field(() => [FieldError], { nullable: true })
  // Setting errors as an array because there could be more than one
  errors?: FieldError[];

  @Field(() => User, { nullable: true })
  user?: User;
}

// Decorate the class with resolver from graphql
@Resolver()
export class UserResolver {
  @Mutation(() => UserResponse)
  async changePassword(
    @Arg("token") token: string,
    @Arg("newPassword") newPassword: string,
    @Ctx() { redis, req }: MyContext
  ): Promise<UserResponse> {
    // basic password validation
    if (newPassword.length <= 3) {
      return {
        errors: [
          {
            field: "newPassword",
            message: "length must be greater than 3",
          },
        ],
      };
    }
    // check the token
    // if the token is not correct, we send back a token error message
    const key = FORGET_PASSWORD_PREFIX + token;
    const userId = await redis.get(key);
    if (!userId) {
      return {
        errors: [
          {
            field: "token",
            message: "token expired",
          },
        ],
      };
    }
    // convert id into num
    const userIdNum = parseInt(userId);
    // we find the user by id
    const user = await User.findOne(userIdNum);

    // if the user doesnt exist (unlikely) we send back a token error again
    if (!user) {
      return {
        errors: [
          {
            field: "token",
            message: "user no longer exists",
          },
        ],
      };
    }

    // if no errors, change the old passeord with the new password
    // save new password to database
    await User.update(
      { id: userIdNum },
      { password: await argon2.hash(newPassword) }
    );

    // token is removed from redis
    // user cant change password again with same token
    await redis.del(key);

    // log in user after change password
    // we add user id to the session -> log them in
    req.session.userId = user.id;

    // finally, return user
    return { user };
  }

  @Mutation(() => Boolean)
  async forgotPassword(
    @Arg("email") email: string,
    @Ctx() { redis }: MyContext
  ) {
    const user = await User.findOne({ where: { email } });
    if (!user) {
      // if no user back. email is not in the db
      // in this case we return true but dont actually send an email
      return true;
    }

    // generate tokeen with uuid
    // uuid library gives us random string
    const token = v4();

    // store the token in redis
    // password token expires in 3 days
    await redis.set(
      FORGET_PASSWORD_PREFIX + token,
      user.id,
      "ex",
      1000 * 60 * 60 * 24 * 3
    );

    // if email exists, we send back an email with a link to change password url
    // user can click on link and redirect to page to change password (unique token in url)
    sendEmail(
      email,
      `<a href="http://localhost:3000/change-password/${token}">reset password </a>`
    );
    return true;
  }

  // Me query
  @Query(() => User, { nullable: true })
  me(@Ctx() { req }: MyContext) {
    // You are not logged in
    if (!req.session.userId) {
      return null;
    }
    // If the user is logged in, we fetch it and return it
    // We know if an user is logged in = if they have cookie
    return User.findOne(req.session.userId);
  }

  // Add an user
  @Mutation(() => UserResponse)
  async register(
    // Different way of passing argument. Creating a class and passing it
    @Arg("options") options: UsernamePasswordInput,
    @Ctx() { req }: MyContext
  ): Promise<UserResponse> {
    const errors = validateRegister(options);
    if (errors) {
      return { errors };
    }

    // Hash the password before storing it, for extra protection
    const hashedPassword = await argon2.hash(options.password);
    let user;
    try {
      user = await User.create({
        username: options.username,
        email: options.email,
        password: hashedPassword,
      }).save();
    } catch (err) {
      if (err.code === "23505") {
        return {
          errors: [
            {
              field: "username",
              message: "username already taken",
            },
          ],
        };
      }
    }
    // store user id session
    // this will set a cookie on the user
    // keep them logged in
    req.session.userId = user?.id;

    // Return the user in the object because we have a response object
    return { user };
  }

  // Login
  @Mutation(() => UserResponse)
  async login(
    // Takes same arguments as registration
    @Arg("usernameOrEmail") usernameOrEmail: string,
    @Arg("password") password: string,
    @Ctx() { req }: MyContext
  ): Promise<UserResponse> {
    // Try to find user, if it doesn't exist, return error
    const user = await User.findOne(
      // if there is an "@", we assume its an email, otherwise its an username
      usernameOrEmail.includes("@")
        ? { where: { email: usernameOrEmail } }
        : { where: { username: usernameOrEmail } }
    );
    if (!user) {
      return {
        errors: [
          {
            field: "usernameOrEmail",
            message: "username/email doesn't exist",
          },
        ],
      };
    }
    // Verify password. If wrong, return error
    const valid = await argon2.verify(user.password, password);
    if (!valid) {
      return {
        errors: [
          {
            field: "password",
            message: "incorrect password",
          },
        ],
      };
    }

    // This is the data we want to store in the session
    // We can add more stuff
    req.session.userId = user.id;

    return { user };
  }

  @Mutation(() => Boolean)
  logout(@Ctx() { req, res }: MyContext) {
    return new Promise((resolve) =>
      req.session.destroy((err) => {
        res.clearCookie(COOKIE_NAME);
        if (err) {
          console.log(err);
          resolve(false);
          return;
        }
        resolve(true);
      })
    );
  }
}
